import { test } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { ServerBlockNoteEditor } from "@blocknote/server-util";
import {
  blocksToState, project, validateBlocks, markdownToBlocks, blocksToMarkdown,
} from "../packages/editor/server.ts";

test("W10a installed BlockNote Core server schema retains basic rich blocks", () => {
  // ServerBlockNoteEditor 0.55.0 does not expose a stable public
  // blockSchema property. Assert supported types by actually encoding
  // and rehydrating them, never by probing private editor internals.
  const editor = ServerBlockNoteEditor.create();
  assert.ok(editor, "installed server editor should construct");
  const content: any[] = [
    {type:"heading",props:{level:2},content:"Project evidence"},
    {type:"paragraph",content:[
      {type:"text",text:"Auditable",styles:{bold:true}},
      {type:"text",text:" context",styles:{italic:true}},
    ]},
    {type:"bulletListItem",content:"First item"},
    {type:"numberedListItem",content:"Second item"},
    {type:"checkListItem",props:{checked:true},content:"Review complete"},
  ];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, blocksToState(content));
    const result = project(doc);
    assert.deepEqual(result.blocks.map((b:any)=>b.type),
      content.map((b)=>b.type));
    assert.match(result.plain_text,/Auditable context/);
    assert.match(JSON.stringify(result.blocks),/"bold":true/);
    assert.match(JSON.stringify(result.blocks),/"italic":true/);
    const second=new Y.Doc();
    try {
      Y.applyUpdate(second,result.state);
      const again=project(second);
      assert.deepEqual(
        again.blocks.map((b:any)=>({type:b.type,content:b.content,children:b.children})),
        result.blocks.map((b:any)=>({type:b.type,content:b.content,children:b.children})),
        "persisted canonical Yjs state must preserve rich block structure");
    } finally { second.destroy(); }
  } finally { doc.destroy(); }
});

test("W10a Markdown fallback is explicitly lossy; hostile block payloads fail", async () => {
  const parsed=await markdownToBlocks("## Brief\n\n- Item A\n- Item B\n");
  assert.equal(parsed[0].type,"heading");
  assert.ok(parsed.some((block:any)=>block.type==="bulletListItem"));
  const output=await blocksToMarkdown(parsed);
  assert.match(output,/Brief/);
  assert.throws(()=>validateBlocks([
    {type:"paragraph",content:[{type:"link",href:"javascript:alert(1)"}]},
  ]),/Unsafe link/);
  assert.throws(()=>validateBlocks([
    {type:"paragraph",content:"x".repeat(4_194_304)},
  ]),/oversized/);
  let nested:any={type:"paragraph",content:"deep"};
  for(let i=0;i<42;i++)nested={children:[nested]};
  assert.throws(()=>validateBlocks([nested]),/nesting too deep/i);
});


test("W10b shared callout and divider survive canonical Yjs reload", () => {
  const original: any[]=[
    {type:"paragraph",content:"Before note"},
    {type:"callout",props:{variant:"warning"},content:[
      {type:"text",text:"Important",styles:{bold:true}},
      {type:"text",text:" decision",styles:{}},
    ]},
    {type:"divider"},
    {type:"paragraph",content:"After divider"},
  ];
  const one=new Y.Doc();
  const two=new Y.Doc();
  try {
    Y.applyUpdate(one,blocksToState(original));
    const projection=project(one);
    assert.deepEqual(projection.blocks.map((v:any)=>v.type),
      ["paragraph","callout","divider","paragraph"]);
    assert.equal((projection.blocks[1] as any).props.variant,"warning");
    assert.match(projection.plain_text,/Important decision/);
    assert.match(JSON.stringify(projection.blocks[1].content),/"bold":true/);
    Y.applyUpdate(two,projection.state);
    const reloaded=project(two);
    assert.deepEqual(reloaded.blocks,projection.blocks);
    assert.equal((reloaded.blocks[1] as any).props.variant,"warning");
    assert.equal(reloaded.blocks[2].type,"divider");
    assert.throws(()=>validateBlocks([{type:"callout",
      props:{variant:"javascript:alert(1)"},content:"x"}]),
      /Invalid callout variant/);
    assert.throws(()=>validateBlocks([{type:"divider",content:"invisible text"}]),
      /Divider cannot contain text/);
  } finally { one.destroy(); two.destroy(); }
});


test("W10c1 default BlockNote 0.55 documents migrate into extended shared schema without loss", () => {
  // A v0.55 Core-only document is the actual deployed W10a/W09 predecessor.
  // The new callout/divider schema must not change existing text, marks,
  // heading levels, list types, IDs, links or children on server projection.
  const oldEditor=ServerBlockNoteEditor.create();
  const legacyDoc=oldEditor.blocksToYDoc([
    {type:"heading",props:{level:3},content:"Preserved heading"},
    {type:"paragraph",content:[
      {type:"text",text:"Underlined",styles:{underline:true}},
      {type:"text",text:" knowledge",styles:{bold:true}},
    ]},
    {type:"checkListItem",props:{checked:true},content:"Old task"},
  ],"document");
  const replay=new Y.Doc();
  try {
    const canonical=project(legacyDoc);
    assert.deepEqual(canonical.blocks.map((b:any)=>b.type),
      ["heading","paragraph","checkListItem"]);
    assert.equal((canonical.blocks[0] as any).props.level,3);
    assert.match(JSON.stringify(canonical.blocks),/"underline":true/);
    assert.equal((canonical.blocks[2] as any).props.checked,true);
    Y.applyUpdate(replay,canonical.state);
    assert.deepEqual(project(replay).blocks,canonical.blocks);
  } finally { legacyDoc.destroy(); replay.destroy(); }
});


test("W10c2 explicit custom block identities and rich marks survive Yjs snapshots", () => {
  const ids=[
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ];
  const original:any[]=[
    {id:ids[0],type:"heading",props:{level:3},content:"Stable title"},
    {id:ids[1],type:"callout",props:{variant:"success"},content:[
      {type:"text",text:"Bold",styles:{bold:true}},
      {type:"text",text:" underlined",styles:{underline:true}},
    ]},
    {id:ids[2],type:"divider"},
  ];
  const first=new Y.Doc();
  const version=new Y.Doc();
  try{
    Y.applyUpdate(first,blocksToState(original));
    const committed=project(first);
    assert.deepEqual(committed.blocks.map((b:any)=>b.id),ids);
    assert.equal((committed.blocks[1] as any).props.variant,"success");
    assert.match(JSON.stringify(committed.blocks[1]),/"underline":true/);
    Y.applyUpdate(version,committed.state);
    const reopened=project(version);
    assert.deepEqual(reopened.blocks,committed.blocks);
  }finally{first.destroy();version.destroy();}
});


test("W10c3a link allowlist rejects executable and protocol-relative URLs", () => {
  const approved=[
    "https://example.org/knowledge",
    "http://example.org/help",
    "mailto:support@example.org",
    "/?page=11111111-1111-4111-8111-111111111111",
    "/api/v1/files/22222222-2222-4222-8222-222222222222/content",
  ];
  for(const href of approved){
    assert.doesNotThrow(()=>validateBlocks([
      {type:"paragraph",content:[{type:"link",href,content:"Approved"}]},
    ]),"expected approved link "+href);
  }
  for(const href of [
    "javascript:alert(1)","data:text/html,<script>alert(1)</script>",
    "vbscript:alert(1)","//example.org/not-canonical",
    "file:///etc/passwd","httpsx://example.org",
  ]){
    assert.throws(()=>validateBlocks([
      {type:"paragraph",content:[{type:"link",href,content:"Untrusted"}]},
    ]),/Unsafe link/,"unsafe link escaped allowlist: "+href);
  }
});
