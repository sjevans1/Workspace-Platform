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
    assert.equal(projection.blocks[1].props.variant,"warning");
    assert.match(projection.plain_text,/Important decision/);
    assert.match(JSON.stringify(projection.blocks[1].content),/"bold":true/);
    Y.applyUpdate(two,projection.state);
    const reloaded=project(two);
    assert.deepEqual(reloaded.blocks,projection.blocks);
    assert.equal(reloaded.blocks[1].props.variant,"warning");
    assert.equal(reloaded.blocks[2].type,"divider");
    assert.throws(()=>validateBlocks([{type:"callout",
      props:{variant:"javascript:alert(1)"},content:"x"}]),
      /Invalid callout variant/);
    assert.throws(()=>validateBlocks([{type:"divider",content:"invisible text"}]),
      /Divider cannot contain text/);
  } finally { one.destroy(); two.destroy(); }
});
