import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  SYNTHETIC_PROVIDER_KEY,
  apiGet,
  createPageResource,
  expectSecretAbsent,
  findWorkflowId,
  openSettings,
  openSettingsTab,
  waitForTerminalRun,
} from "./support";

// W29-A / W30-A connected-work browser acceptance.
//
// One tenant drives the whole file, so the two empty-state tests come first and
// every later test arranges its own state through the API and observes it
// through the real Settings UI. Run against a pristine database (see
// scripts/dev.ts with TEST_DATABASE_URL); the setup project creates the tenant.
//
// This file owns no other lane: the default playwright.config.ts testIgnore and
// ci.yml are deliberately untouched.

function manualNotificationDefinition(resourceId: string) {
  return {
    schema_version: 1,
    trigger: { id: "trigger-1", type: "manual" },
    conditions: [],
    actions: [
      {
        id: "action-1",
        operation: "workspace.notification.create",
        config: {
          resource_id: resourceId,
          message: "Connected-work acceptance notification",
        },
      },
    ],
  };
}

// connector.action.invoke against a connection id that does not exist fails
// closed with a non-retryable connector classification, so the run settles
// immediately and the failure is recorded on the step.
function failingConnectorDefinition() {
  return {
    schema_version: 1,
    trigger: { id: "trigger-1", type: "manual" },
    conditions: [],
    actions: [
      {
        id: "action-1",
        operation: "connector.action.invoke",
        config: {
          connection_id: randomUUID(),
          action: "synthetic.record",
          capability: "message.send",
        },
      },
    ],
  };
}

test("a fresh workspace shows the Connectors empty state", async ({ page }) => {
  await openSettingsTab(page, "Connections");
  await expect(
    page.getByRole("heading", { name: "Connections", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No connections yet." }),
  ).toBeVisible();
  await expect(
    page.getByText("Workspace works fully without any external connection."),
  ).toBeVisible();
  // Providers that exist only as metadata are named honestly, never offered.
  await expect(
    page.getByText("Declared but not implemented in this release:"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "New connection" }),
  ).toBeVisible();
});

test("a fresh workspace shows the Automations empty state", async ({
  page,
}) => {
  await openSettingsTab(page, "Automations");
  await expect(
    page.getByRole("heading", { name: "Automations", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "No workflows yet." }),
  ).toBeVisible();
  // The catalog reference names the real operations the engine will accept.
  await page.getByText("Catalog reference").click();
  await expect(page.getByText(/workspace\.notification\.create/)).toBeVisible();
});

test("creates, connects, tests, syncs, disables, re-enables and revokes a synthetic connection without rendering the secret", async ({
  page,
}) => {
  test.setTimeout(120000);
  const label = `Acceptance connector ${randomUUID().slice(0, 8)}`;
  const secret = `cw-secret-${randomUUID()}-material`;
  expect(secret.length).toBeGreaterThanOrEqual(16);

  await openSettingsTab(page, "Connections");

  // W29-P0/A2 endpoint readiness: the guided check resolves and evaluates without
  // ever contacting the endpoint. "localhost" is not a canonical public hostname, so
  // the answer is deterministic and needs no DNS: this proves the form, the API call
  // and the shared readiness vocabulary are wired, not the runner's resolver.
  const readiness = page.locator(".endpoint-readiness");
  await readiness.getByLabel("Host").fill("localhost");
  await readiness.getByRole("button", { name: "Check network readiness" }).click();
  const readinessResult = readiness.getByRole("status");
  await expect(readinessResult).toContainText("Not a valid public hostname");
  await expect(readinessResult).toContainText("no endpoint contact");
  // Re-review: a verdict belongs to the inputs it came from. Editing the host
  // clears it, so a previous answer can never appear to describe the new value.
  await readiness.getByLabel("Host").fill("mail.internal.example");
  await expect(readiness.getByRole("status")).toHaveCount(0);
  await readiness.getByLabel("Host").fill("localhost");
  await readiness
    .getByRole("button", { name: "Check network readiness" })
    .click();
  await expect(readiness.getByRole("status")).toContainText(
    "Not a valid public hostname",
  );
  // Changing the use case clears it too, and the port list follows the use case.
  await readiness.getByLabel("Use case").selectOption("https");
  await expect(readiness.getByRole("status")).toHaveCount(0);
  await expect(readiness.getByLabel("Port")).toHaveValue("443");

  // Re-review: an answer still in flight when the administrator edits the form must
  // never be restored. The first request is held for a deterministic 1.5s, the host
  // is edited while it is outstanding, and the verdict must stay absent after the
  // response has certainly landed.
  let held = true;
  await page.route("**/api/v1/connectors/endpoints/preflight", async (route) => {
    if (held) {
      held = false;
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    await route.continue();
  });
  await readiness.getByLabel("Use case").selectOption("custom_imap");
  await readiness.getByLabel("Host").fill("localhost");
  await readiness
    .getByRole("button", { name: "Check network readiness" })
    .click();
  await readiness.getByLabel("Host").fill("mail.internal.example");
  await page.waitForTimeout(2500);
  await expect(readiness.getByRole("status")).toHaveCount(0);
  await page.unroute("**/api/v1/connectors/endpoints/preflight");
  // A check for the current inputs still works, and editing clears it again. The
  // host is the deterministic non-public one, so this never depends on DNS.
  await readiness.getByLabel("Host").fill("localhost");
  await readiness
    .getByRole("button", { name: "Check network readiness" })
    .click();
  await expect(readiness.getByRole("status")).toContainText(
    "Not a valid public hostname",
  );
  await readiness.getByLabel("Host").fill("mail.internal.example");
  await expect(readiness.getByRole("status")).toHaveCount(0);
  // Selecting a provider or typing a host never mutates anything: the check is a
  // read-only question, and the connection below still does not exist.
  await expect(page.locator(".integration-row").filter({ hasText: label })).toHaveCount(0);

  await page.getByRole("button", { name: "New connection" }).click();
  const createModal = page.getByRole("dialog", { name: "New connection" });
  await expect(createModal).toBeVisible();
  await createModal.getByLabel("Provider").selectOption(SYNTHETIC_PROVIDER_KEY);
  await createModal.getByLabel("Label", { exact: true }).fill(label);
  await createModal.getByLabel("Ownership").selectOption("user");
  await createModal.getByRole("button", { name: "Create connection" }).click();

  const connectModal = page.getByRole("dialog", {
    name: `Connect ${label}`,
  });
  await expect(connectModal).toBeVisible();
  await connectModal
    .getByLabel("Credential (an operator-supplied token or secret)")
    .fill(secret);
  await connectModal
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(connectModal).toBeHidden();

  const row = page.locator(".integration-row").filter({ hasText: label });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Synthetic test provider");
  await expect(row).toContainText("Delegated user");
  await expect(row.locator(".tag")).toHaveText("connected");
  await expect(row).toContainText(
    "Capabilities granted: connection.health, connection.sync, message.receive, message.send",
  );
  await expect(row).toContainText("enabled");

  // Test connection: the adapter is genuinely asked, not assumed.
  await row.getByRole("button", { name: "Test", exact: true }).click();
  await expect(row.getByRole("status")).toContainText(
    "Health check succeeded.",
  );

  // Sync request.
  await row.getByRole("button", { name: "Sync now" }).click();
  await expect(row.getByRole("status")).toContainText(
    /Sync queued; the worker performs it/,
  );
  await expect(row.getByRole("status")).toContainText("Next attempt");

  // Disable, then re-enable. Both are deliberate: the button opens a review dialog
  // that names the consequence, and only the confirm button calls the API.
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  const disableDialog = page.getByRole("dialog", { name: `Disable ${label}?` });
  await expect(disableDialog).toBeVisible();
  await expect(disableDialog).toContainText("stored credential is kept");
  // Cancelling changes nothing.
  await disableDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(disableDialog).toBeHidden();
  await expect(row.locator(".tag")).toHaveText("connected");
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await disableDialog.getByRole("button", { name: "Disable connection" }).click();
  await expect(disableDialog).toBeHidden();
  await expect(
    row.getByRole("button", { name: "Enable", exact: true }),
  ).toBeVisible();
  await expect(row.locator(".tag")).toHaveText("disabled");
  await expect(row.getByRole("button", { name: "Sync now" })).toHaveCount(0);
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  const enableDialog = page.getByRole("dialog", { name: `Enable ${label}?` });
  await enableDialog.getByRole("button", { name: "Enable connection" }).click();
  await expect(enableDialog).toBeHidden();
  await expect(row.locator(".tag")).toHaveText("connected");
  await expect(row.getByRole("button", { name: "Sync now" })).toBeVisible();

  // The supplied secret is nowhere the browser or the API can reach.
  await expectSecretAbsent(page, secret);

  // Revoke destroys the credential and the granted capabilities. It states the
  // consequence before it acts, because it cannot be undone.
  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  const revokeDialog = page.getByRole("dialog", { name: `Revoke ${label}?` });
  await expect(revokeDialog).toBeVisible();
  await expect(revokeDialog).toContainText("cannot be re-enabled");
  await revokeDialog.getByRole("button", { name: "Revoke connection" }).click();
  await expect(revokeDialog).toBeHidden();
  await expect(row.locator(".tag")).toHaveText("revoked");
  await expect(row).toContainText("Capabilities granted: none");
  await expect(row).toContainText(
    "Needs attention: Revoked by an administrator",
  );
  // A revoked connection exposes no management actions at all.
  await expect(row.getByRole("button")).toHaveCount(0);
  await expectSecretAbsent(page, secret);
});

test("creates, validates, saves, enables and runs a notification workflow, then shows history and step detail", async ({
  page,
}) => {
  test.setTimeout(120000);
  const name = `Notify workflow ${randomUUID().slice(0, 8)}`;
  const resourceId = await createPageResource(
    page,
    `Notification target ${name}`,
  );

  await openSettingsTab(page, "Automations");

  await page.getByRole("button", { name: "New workflow" }).click();
  const createModal = page.getByRole("dialog", { name: "New workflow" });
  await expect(createModal).toBeVisible();
  await createModal.getByLabel("Name", { exact: true }).fill(name);
  await createModal
    .getByLabel("Workflow definition")
    .fill(JSON.stringify(manualNotificationDefinition(resourceId), null, 2));
  await createModal.getByRole("button", { name: "Create workflow" }).click();
  await expect(createModal).toBeHidden();

  const row = page.locator(".integration-row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await expect(row).toContainText("Manual");
  await expect(row.locator(".tag")).toHaveText("draft");
  await expect(row).toContainText("revision 1");
  await expect(row).toContainText("not published");
  await expect(row).toContainText("No runs yet.");

  // Validate the draft in the editor.
  await row.getByRole("button", { name: "Edit", exact: true }).click();
  const editModal = page.getByRole("dialog", { name: `Edit ${name}` });
  await expect(editModal).toBeVisible();
  await editModal
    .getByRole("button", { name: "Validate", exact: true })
    .click();
  await expect(editModal.locator(".automations-plan")).toContainText(
    "trigger.manual",
  );
  await expect(editModal.locator(".automations-plan")).toContainText(
    "workspace.notification.create",
  );

  // Save a new immutable draft revision.
  await editModal
    .getByRole("button", { name: "Save draft", exact: true })
    .click();
  await editModal.getByRole("button", { name: "Close dialog" }).click();
  await expect(row).toContainText("revision 2");

  // Enable publishes the current draft.
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(row.locator(".tag")).toHaveText("enabled");
  await expect(row).toContainText("published 2");

  // Run now, then wait for the worker to execute the run.
  await row.getByRole("button", { name: "Run now" }).click();
  const workflowId = await findWorkflowId(page, name);
  const run = await waitForTerminalRun(page, workflowId);
  expect(run.status).toBe("succeeded");
  expect(run.step_count).toBe(2);

  // Run history through the UI.
  await row.getByRole("button", { name: "Runs", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Run history" }),
  ).toBeVisible();
  const runRow = page
    .locator("table.simple-table tbody tr")
    .filter({ hasText: name });
  await expect(runRow).toHaveCount(1);
  await expect(runRow.locator(".tag")).toHaveText("succeeded");
  await expect(runRow.getByText("2/2")).toBeVisible();
  await runRow.getByRole("button", { name: "Open" }).click();

  const runDialog = page.getByRole("dialog", { name: /^Run / });
  await expect(runDialog).toBeVisible();
  await expect(runDialog).toContainText("status succeeded");
  const steps = runDialog.locator("table.simple-table tbody tr");
  await expect(steps).toHaveCount(2);
  await expect(runDialog).toContainText("trigger.manual");
  await expect(runDialog).toContainText("workspace.notification.create");
  await expect(steps.nth(0).locator(".tag")).toHaveText("succeeded");
  await expect(steps.nth(1).locator(".tag")).toHaveText("succeeded");
});

test("presents a failing action honestly in the run detail", async ({
  page,
}) => {
  test.setTimeout(120000);
  const name = `Failing workflow ${randomUUID().slice(0, 8)}`;

  await openSettingsTab(page, "Automations");

  await page.getByRole("button", { name: "New workflow" }).click();
  const createModal = page.getByRole("dialog", { name: "New workflow" });
  await createModal.getByLabel("Name", { exact: true }).fill(name);
  await createModal
    .getByLabel("Workflow definition")
    .fill(JSON.stringify(failingConnectorDefinition(), null, 2));
  await createModal.getByRole("button", { name: "Create workflow" }).click();
  await expect(createModal).toBeHidden();

  const row = page.locator(".integration-row").filter({ hasText: name });
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(row.locator(".tag")).toHaveText("enabled");
  await row.getByRole("button", { name: "Run now" }).click();

  const workflowId = await findWorkflowId(page, name);
  const run = await waitForTerminalRun(page, workflowId);
  expect(run.status).toBe("failed");
  expect(run.error_category).toBe("capability_missing");

  await row.getByRole("button", { name: "Runs", exact: true }).click();
  const runRow = page
    .locator("table.simple-table tbody tr")
    .filter({ hasText: name });
  await expect(runRow.locator(".tag")).toHaveText("failed");
  await runRow.getByRole("button", { name: "Open" }).click();

  const runDialog = page.getByRole("dialog", { name: /^Run / });
  await expect(runDialog).toContainText("status failed");
  await expect(runDialog).toContainText("error capability_missing");
  const failedStep = runDialog
    .locator("table.simple-table tbody tr")
    .filter({ hasText: "connector.action.invoke" });
  await expect(failedStep).toHaveCount(1);
  await expect(failedStep.locator(".tag")).toHaveText("failed");
  await expect(failedStep).toContainText("capability_missing");
});

test("a disabled workflow refuses a manual run", async ({ page }) => {
  test.setTimeout(120000);
  const name = `Disabled workflow ${randomUUID().slice(0, 8)}`;

  await openSettingsTab(page, "Automations");

  await page.getByRole("button", { name: "New workflow" }).click();
  const createModal = page.getByRole("dialog", { name: "New workflow" });
  await createModal.getByLabel("Name", { exact: true }).fill(name);
  // The starter definition (manual trigger, one delay action) validates as-is.
  await createModal.getByRole("button", { name: "Create workflow" }).click();
  await expect(createModal).toBeHidden();

  const row = page.locator(".integration-row").filter({ hasText: name });
  await row.getByRole("button", { name: "Enable", exact: true }).click();
  await expect(row.locator(".tag")).toHaveText("enabled");
  await row.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(row.locator(".tag")).toHaveText("disabled");

  const workflowId = await findWorkflowId(page, name);
  const before = await apiGet(
    page,
    `/automations/runs?workflow_id=${workflowId}&limit=50`,
  );

  await row.getByRole("button", { name: "Run now" }).click();
  await expect(page.locator(".toast")).toContainText(
    "Enable the workflow before running it",
  );

  const after = await apiGet(
    page,
    `/automations/runs?workflow_id=${workflowId}&limit=50`,
  );
  expect(after.runs.length).toBe((before.runs || []).length);
});
