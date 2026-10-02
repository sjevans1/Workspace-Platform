import test from "node:test";
import assert from "node:assert/strict";
import {
  readCsvTable, prepareCsvImport, previewCsvImport,
  type CsvColumnMapping,
} from "../packages/imports/csv.ts";

const csv = "Name,Units,Due,Done,Note\n" +
  'Alpha,12,2026-10-01,true,"=SUM(1,2)"\n' +
  "Beta,0,2026-10-02,false,plain\n";

test("W09 CSV preview is bounded, BOM-aware, immutable and only proposes types", () => {
  const file = "\uFEFF" + csv;
  const parsed = readCsvTable(file);
  assert.deepEqual(parsed.columns, ["Name", "Units", "Due", "Done", "Note"]);
  const preview = previewCsvImport(file);
  assert.equal(preview.row_count, 2);
  assert.deepEqual(preview.mapping.map(m => m.type),
    ["title", "number", "date", "checkbox", "text"]);
  assert.equal(preview.sample[0][4], "=SUM(1,2)",
    "preview preserves content as data; React renders it as text");
  assert.equal(preview.sample.length, 2);
  const normal = prepareCsvImport(csv);
  assert.deepEqual(normal.properties.map(x=>x.type),
    ["title","text","text","text","text"],
    "unmapped legacy CSV preserves all non-title fields as text");
  assert.equal(normal.rows[0].field1, "12");
});

test("W09 mapped numeric, date, checkbox and excluded columns are typed", () => {
  const choices: CsvColumnMapping[] = [
    {source:"Name",id:"name",name:"Product",type:"title"},
    {source:"Units",id:"units",name:"Units",type:"number"},
    {source:"Due",id:"due",name:"Due",type:"date"},
    {source:"Done",id:"done",name:"Done",type:"checkbox"},
    {source:"Note",id:"unused",name:"Unused",type:"text",skip:true},
  ];
  const result = prepareCsvImport(csv,choices);
  assert.deepEqual(result.properties.map(x=>x.id),
    ["name","units","due","done"]);
  assert.deepEqual(result.rows[0],
    {name:"Alpha",units:12,due:"2026-10-01",done:true});
  assert.deepEqual(result.rows[1],
    {name:"Beta",units:0,due:"2026-10-02",done:false});
  assert.throws(() => prepareCsvImport(
    csv.replace("12", "not a number"), choices), /data row 1/);
  assert.throws(() => prepareCsvImport(
    csv.replace("2026-10-02", "2026-02-30"), choices), /data row 2/);
  assert.throws(() => prepareCsvImport(
    csv.replace("false", "maybe"), choices), /data row 2/);
  assert.throws(() => prepareCsvImport(csv.replace("Alpha",""),choices),
    /data row 1/);
});

test("W09 mapping/header validation prevents collisions and ambiguous CSV", () => {
  const invalidExamples = [
    "Name,Name\nA,B", "Name,name\nA,B", "Name,\nA,B",
    "Name,Count\nA", 'Name\n"unterminated',
    "Name\n", "Name\n" + "x".repeat(100001),
    "Name\n" + Array.from({length:2001}, (_,i)=>String(i)).join("\n"),
    "Name\n" + "x".repeat(2097153),
  ];
  invalidExamples.forEach((bad, index) =>
    assert.throws(() => readCsvTable(bad),
      "Bad CSV fixture index " + index + " must be rejected"));
  const mapping = previewCsvImport(csv).mapping;
  assert.throws(() => prepareCsvImport(csv,
    mapping.slice(0,4)), /column/);
  assert.throws(() => prepareCsvImport(csv,[
    {...mapping[0],id:"score"}, {...mapping[1],id:"score"},
    ...mapping.slice(2)]), /identifiers/);
  assert.throws(() => prepareCsvImport(csv,[
    {...mapping[0],type:"text"}, ...mapping.slice(1)]), /title/);
  assert.throws(() => prepareCsvImport(csv,[
    {...mapping[0],source:"Fake"}, ...mapping.slice(1)]), /headings/);
  assert.throws(() => prepareCsvImport(csv,[
    {...mapping[0],type:"text",skip:true}, ...mapping.slice(1)]),
    /title/);
});
