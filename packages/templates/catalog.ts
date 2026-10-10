// Wave X X2.5 (W25-T): curated built-in template catalog.
//
// Sections mirror the review categories. Definitions are deterministic and
// versioned; they reference internal resources symbolically and never embed
// UUIDs or tenant IDs. See ./schema.ts for the schema and validator.
import type {
  TemplateDefinition,
  TemplateProperty,
  TemplateResource,
} from "./schema";

const title = (name = "Name"): TemplateProperty => ({
  id: "name",
  name,
  type: "title",
});
const status = (options: string[]): TemplateProperty => ({
  id: "status",
  name: "Status",
  type: "status",
  options,
});
const owner = (name = "Owner"): TemplateProperty => ({
  id: "owner",
  name,
  type: "person",
});
const due = (name = "Due"): TemplateProperty => ({
  id: "due",
  name,
  type: "date",
});
const priority = (options = ["Low", "Medium", "High"]): TemplateProperty => ({
  id: "priority",
  name: "Priority",
  type: "select",
  options,
});

const page = (
  title_: string,
  description: string,
  icon: string,
  headings: string[],
): TemplateDefinition => ({
  id: title_.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
  version: 1,
  level: "page",
  category: "Knowledge",
  title: title_,
  description,
  icon,
  resource: {
    key: "root",
    kind: "page",
    title: title_,
    icon,
    blocks: [
      { type: "heading", props: { level: 1 }, content: title_ },
      ...headings.flatMap((text) => [
        { type: "heading", props: { level: 2 }, content: text },
        { type: "paragraph", content: "Add the details your team needs." },
      ]),
    ],
  },
});

// ---------------------------------------------------------------------------
// Page templates
// ---------------------------------------------------------------------------
const pageTemplates: TemplateDefinition[] = [
  page("Standard operating procedure", "Document a repeatable way of working.", "↳", [
    "Purpose and scope",
    "Procedure",
    "Responsibilities",
    "Review",
  ]),
  page("Meeting notes", "Turn conversations into clear next steps.", "☷", [
    "Attendees",
    "Agenda",
    "Decisions",
    "Actions",
  ]),
  page("Project brief", "Frame a project before work starts.", "◈", [
    "Objective",
    "Scope and out of scope",
    "Milestones",
    "Risks",
  ]),
  page("Decision log", "Remember the why behind the what.", "◎", [
    "Decision",
    "Context",
    "Alternatives considered",
    "Owner and follow-up",
  ]),
  page("Policy", "State a rule clearly and make it reviewable.", "⚖", [
    "Policy statement",
    "Applies to",
    "Exceptions",
    "Review cycle",
  ]),
  page("Weekly review", "Close the week and set the next one.", "◷", [
    "Wins",
    "Blockers",
    "Decisions needed",
    "Next week's focus",
  ]),
];

// ---------------------------------------------------------------------------
// Database templates
// ---------------------------------------------------------------------------
const table = (name = "All records") => ({
  name,
  config: { type: "table", filters: [], sort: [] },
});
const board = (groupBy: string, name = "By " + groupBy) => ({
  name,
  config: { type: "board", groupBy, filters: [], sort: [] },
});

const databaseTemplates: TemplateDefinition[] = [
  {
    id: "task-tracker",
    version: 1,
    level: "database",
    category: "Projects & Delivery",
    title: "Task tracker",
    description: "Plan, assign and move work to done.",
    icon: "☑",
    resource: {
      key: "root",
      kind: "database",
      title: "Tasks",
      icon: "☑",
      properties: [
        title("Task"),
        status(["Not started", "In progress", "Blocked", "Done"]),
        owner(),
        priority(),
        due(),
      ],
      views: [table(), board("status")],
      records: [
        {
          key: "example_task",
          values: {
            name: "Example: draft the project brief",
            status: "Not started",
            priority: "Medium",
          },
        },
      ],
    },
  },
  {
    id: "sales-pipeline",
    version: 1,
    level: "database",
    category: "Sales & CRM",
    title: "Sales pipeline",
    description: "Track opportunities through a sales process.",
    icon: "◈",
    resource: {
      key: "root",
      kind: "database",
      title: "Opportunities",
      icon: "◈",
      properties: [
        title("Opportunity"),
        {
          id: "stage",
          name: "Stage",
          type: "status",
          options: ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"],
        },
        { id: "value", name: "Value", type: "number" },
        owner(),
        { id: "close", name: "Expected close", type: "date" },
      ],
      views: [table(), board("stage")],
      records: [
        {
          key: "example_opportunity",
          values: { name: "Example: Acme renewal", stage: "Qualified", value: 12000 },
        },
      ],
    },
  },
  {
    id: "risk-register",
    version: 1,
    level: "database",
    category: "Risk & Compliance",
    title: "Risk register",
    description: "Record risks, owners, likelihood and treatment.",
    icon: "⚠",
    resource: {
      key: "root",
      kind: "database",
      title: "Risks",
      icon: "⚠",
      properties: [
        title("Risk"),
        {
          id: "likelihood",
          name: "Likelihood",
          type: "select",
          options: ["Low", "Medium", "High"],
        },
        {
          id: "impact",
          name: "Impact",
          type: "select",
          options: ["Low", "Medium", "High"],
        },
        {
          id: "status",
          name: "Treatment",
          type: "status",
          options: ["Open", "Mitigating", "Accepted", "Closed"],
        },
        owner(),
      ],
      views: [table(), board("status")],
      records: [
        {
          key: "example_risk",
          values: {
            name: "Example: single supplier dependency",
            likelihood: "Medium",
            impact: "High",
            status: "Open",
          },
        },
      ],
    },
  },
  {
    id: "vendor-register",
    version: 1,
    level: "database",
    category: "Operations",
    title: "Vendor register",
    description: "Keep suppliers, contracts and review dates in one place.",
    icon: "⚑",
    resource: {
      key: "root",
      kind: "database",
      title: "Vendors",
      icon: "⚑",
      properties: [
        title("Vendor"),
        { id: "category", name: "Category", type: "text" },
        { id: "contract_end", name: "Contract end", type: "date" },
        owner(),
        {
          id: "status",
          name: "Status",
          type: "status",
          options: ["Prospective", "Active", "Under review", "Ended"],
        },
      ],
      views: [table(), board("status")],
      records: [
        {
          key: "example_vendor",
          values: { name: "Example: Northwind Supplies", status: "Active" },
        },
      ],
    },
  },
  {
    id: "recruitment-pipeline",
    version: 1,
    level: "database",
    category: "HR & People",
    title: "Recruitment pipeline",
    description: "Move candidates through a hiring process.",
    icon: "☰",
    resource: {
      key: "root",
      kind: "database",
      title: "Candidates",
      icon: "☰",
      properties: [
        title("Candidate"),
        { id: "role", name: "Role", type: "text" },
        {
          id: "stage",
          name: "Stage",
          type: "status",
          options: ["Applied", "Screen", "Interview", "Offer", "Hired", "Rejected"],
        },
        { id: "interview", name: "Next interview", type: "date" },
        owner("Recruiter"),
      ],
      views: [table(), board("stage")],
      records: [
        {
          key: "example_candidate",
          values: { name: "Example: candidate for analyst role", stage: "Applied" },
        },
      ],
    },
  },
  {
    id: "expense-tracker",
    version: 1,
    level: "database",
    category: "Finance",
    title: "Expense tracker",
    description: "Capture spend with amounts, dates and approvals.",
    icon: "₪",
    resource: {
      key: "root",
      kind: "database",
      title: "Expenses",
      icon: "₪",
      properties: [
        title("Expense"),
        { id: "amount", name: "Amount", type: "number" },
        { id: "spent", name: "Date", type: "date" },
        {
          id: "status",
          name: "Approval",
          type: "status",
          options: ["Submitted", "Approved", "Rejected"],
        },
        owner("Submitted by"),
      ],
      views: [table()],
      records: [
        {
          key: "example_expense",
          values: { name: "Example: team offsite", amount: 240, status: "Submitted" },
        },
      ],
    },
  },
  {
    id: "knowledge-index",
    version: 1,
    level: "database",
    category: "Knowledge",
    title: "Knowledge index",
    description: "Catalogue documents, owners and review dates.",
    icon: "📖",
    resource: {
      key: "root",
      kind: "database",
      title: "Knowledge index",
      icon: "📖",
      properties: [
        title("Document"),
        { id: "topic", name: "Topic", type: "text" },
        owner(),
        { id: "review", name: "Next review", type: "date" },
      ],
      views: [table()],
      records: [
        {
          key: "example_document",
          values: { name: "Example: onboarding guide", topic: "People" },
        },
      ],
    },
  },
  {
    id: "contact-directory",
    version: 1,
    level: "database",
    category: "Sales & CRM",
    title: "Contact directory",
    description: "Keep the people you work with and their context.",
    icon: "☺",
    resource: {
      key: "root",
      kind: "database",
      title: "Contacts",
      icon: "☺",
      properties: [
        title("Contact"),
        { id: "organisation", name: "Organisation", type: "text" },
        { id: "email", name: "Email", type: "text" },
        owner("Relationship owner"),
      ],
      views: [table()],
      records: [
        {
          key: "example_contact",
          values: { name: "Example: Alex Doe", organisation: "Northwind" },
        },
      ],
    },
  },
  {
    id: "personal-tasks",
    version: 1,
    level: "database",
    category: "Personal Productivity",
    title: "Personal task list",
    description: "A small, focused list for personal follow-ups.",
    icon: "✓",
    resource: {
      key: "root",
      kind: "database",
      title: "My tasks",
      icon: "✓",
      properties: [
        title("Task"),
        status(["Today", "This week", "Later", "Done"]),
        due(),
        priority(["Low", "Medium", "High"]),
      ],
      views: [table(), board("status")],
      records: [
        {
          key: "example_personal",
          values: { name: "Example: prepare weekly review", status: "Today" },
        },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Multi-resource space templates
// ---------------------------------------------------------------------------
const db = (
  key: string,
  title_: string,
  icon: string,
  properties: TemplateProperty[],
  views: Array<{ name: string; config: Record<string, unknown> }>,
  records: TemplateResource["records"] = [],
): TemplateResource => ({
  key,
  kind: "database",
  title: title_,
  icon,
  properties,
  views,
  records,
});

const pageChild = (
  key: string,
  title_: string,
  icon: string,
  headings: string[],
): TemplateResource => ({
  key,
  kind: "page",
  title: title_,
  icon,
  blocks: headings.flatMap((text) => [
    { type: "heading", props: { level: 2 }, content: text },
    { type: "paragraph", content: "Add the details your team needs." },
  ]),
});

const spaceTemplates: TemplateDefinition[] = [
  {
    id: "project-management",
    version: 1,
    level: "space",
    category: "Projects & Delivery",
    title: "Project Management",
    description:
      "A coherent project system: brief, plan, tasks, risks and decisions, with tasks related to projects.",
    icon: "◈",
    resource: {
      key: "root",
      kind: "space",
      title: "Project Management",
      icon: "◈",
      children: [
        pageChild("overview", "Project brief", "◈", [
          "Objective",
          "Scope",
          "Milestones",
        ]),
        db(
          "projects",
          "Projects",
          "◈",
          [title("Project"), status(["Planned", "Active", "On hold", "Done"]), owner(), due("Target date")],
          [table(), board("status")],
          [{ key: "example_project", values: { name: "Example: website relaunch", status: "Planned" } }],
        ),
        db(
          "tasks",
          "Tasks",
          "☑",
          [
            title("Task"),
            status(["Not started", "In progress", "Blocked", "Done"]),
            owner(),
            priority(),
            due(),
            { id: "project", name: "Project", type: "relation", target: "resources.projects" },
          ],
          [table(), board("status")],
          [
            {
              key: "example_task",
              values: { name: "Example: draft brief", status: "Not started" },
              refs: { project: ["resources.example_project"] },
            },
          ],
        ),
        db(
          "risks",
          "Risks",
          "⚠",
          [title("Risk"), status(["Open", "Mitigating", "Closed"]), owner(), priority()],
          [table()],
          [{ key: "example_risk", values: { name: "Example: unclear scope", status: "Open" } }],
        ),
        pageChild("decisions", "Decision log", "◎", [
          "Decision",
          "Context",
          "Owner and follow-up",
        ]),
      ],
    },
  },
  {
    id: "hr-workspace",
    version: 1,
    level: "space",
    category: "HR & People",
    title: "HR Workspace",
    description:
      "People directory, recruitment pipeline and policy pages in one structure.",
    icon: "☺",
    resource: {
      key: "root",
      kind: "space",
      title: "HR Workspace",
      icon: "☺",
      children: [
        db(
          "people",
          "People directory",
          "☺",
          [title("Person"), { id: "role", name: "Role", type: "text" }, owner("Manager"), { id: "start", name: "Start date", type: "date" }],
          [table()],
          [{ key: "example_person", values: { name: "Example: new starter", role: "Analyst" } }],
        ),
        db(
          "recruitment",
          "Recruitment",
          "☰",
          [
            title("Candidate"),
            status(["Applied", "Screen", "Interview", "Offer", "Hired", "Rejected"]),
            { id: "role", name: "Role", type: "text" },
            { id: "person", name: "Person", type: "relation", target: "resources.people" },
          ],
          [table(), board("status")],
          [
            {
              key: "example_candidate",
              values: { name: "Example: candidate", status: "Applied" },
              refs: { person: ["resources.example_person"] },
            },
          ],
        ),
        pageChild("policies", "Policies", "⚖", ["Policy statement", "Applies to"]),
      ],
    },
  },
  {
    id: "client-delivery",
    version: 1,
    level: "space",
    category: "Sales & CRM",
    title: "Client Delivery",
    description:
      "Clients, engagements and delivery tasks that relate to each other.",
    icon: "⚑",
    resource: {
      key: "root",
      kind: "space",
      title: "Client Delivery",
      icon: "⚑",
      children: [
        db(
          "clients",
          "Clients",
          "⚑",
          [title("Client"), owner("Account owner"), status(["Prospect", "Active", "Past"])],
          [table(), board("status")],
          [{ key: "example_client", values: { name: "Example: Northwind", status: "Active" } }],
        ),
        db(
          "engagements",
          "Engagements",
          "◈",
          [
            title("Engagement"),
            status(["Scoping", "Delivery", "Review", "Closed"]),
            { id: "client", name: "Client", type: "relation", target: "resources.clients" },
            due("Next review"),
          ],
          [table(), board("status")],
          [
            {
              key: "example_engagement",
              values: { name: "Example: onboarding project", status: "Scoping" },
              refs: { client: ["resources.example_client"] },
            },
          ],
        ),
        pageChild("meetings", "Meeting notes", "☷", ["Attendees", "Decisions", "Actions"]),
      ],
    },
  },
  {
    id: "operations",
    version: 1,
    level: "space",
    category: "Operations",
    title: "Operations",
    description:
      "Run day-to-day operations: SOPs, incidents, maintenance and shift handover.",
    icon: "⚙",
    resource: {
      key: "root",
      kind: "space",
      title: "Operations",
      icon: "⚙",
      children: [
        db(
          "incidents",
          "Incident log",
          "⚠",
          [title("Incident"), status(["Open", "Investigating", "Resolved"]), owner(), { id: "raised", name: "Raised", type: "date" }],
          [table(), board("status")],
          [{ key: "example_incident", values: { name: "Example: production delay", status: "Open" } }],
        ),
        db(
          "maintenance",
          "Maintenance log",
          "⚒",
          [title("Task"), status(["Due", "Scheduled", "Done"]), due("When"), owner()],
          [table()],
          [{ key: "example_maintenance", values: { name: "Example: quarterly service", status: "Due" } }],
        ),
        pageChild("sops", "SOP library", "↳", ["Purpose and scope", "Procedure"]),
        pageChild("handover", "Shift handover", "◷", ["Current state", "Open issues", "Next shift"]),
      ],
    },
  },
  {
    id: "management-review",
    version: 1,
    level: "space",
    category: "Management",
    title: "Management Review",
    description:
      "KPIs, weekly and monthly reviews, objectives and a decision log.",
    icon: "◴",
    resource: {
      key: "root",
      kind: "space",
      title: "Management Review",
      icon: "◴",
      children: [
        db(
          "kpis",
          "KPIs",
          "◴",
          [title("Measure"), { id: "target", name: "Target", type: "number" }, { id: "actual", name: "Actual", type: "number" }, owner()],
          [table()],
          [{ key: "example_kpi", values: { name: "Example: monthly revenue", target: 100000, actual: 0 } }],
        ),
        db(
          "objectives",
          "Objectives",
          "◎",
          [title("Objective"), status(["Planned", "On track", "At risk", "Done"]), owner(), due("Review date")],
          [table(), board("status")],
          [{ key: "example_objective", values: { name: "Example: improve retention", status: "Planned" } }],
        ),
        pageChild("weekly", "Weekly review", "◷", ["Wins", "Blockers", "Next week"]),
        pageChild("decisions", "Decision log", "◎", ["Decision", "Owner and follow-up"]),
      ],
    },
  },
];

export const catalog: TemplateDefinition[] = [
  ...pageTemplates,
  ...databaseTemplates,
  ...spaceTemplates,
];
