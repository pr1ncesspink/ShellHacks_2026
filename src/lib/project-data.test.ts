import test from 'node:test';
import assert from 'node:assert/strict';
import { parseProjectPage, validateDraft, toMapProject, proximityPairs, milesBetween } from './project-data.ts';

test('extracts multiple labeled projects and hemisphere coordinates without changing dates', () => {
  const rows=parseProjectPage('Project: Atlanta Water\nLatitude: 33.749 N\nLongitude: 84.388 W\nIn-service date: 2027-06-01\nOwner: City\n\nProject name: Road B\nLatitude: 33.80\nLongitude: -84.40\nIn-service year: 2028','test.pdf',2);
  assert.equal(rows.length,2); assert.equal(rows[0].longitude,'-84.388'); assert.equal(rows[0].schedule,'2027-06-01');
  assert.equal(rows[1].schedule,'2028'); assert.equal(toMapProject(rows[0]).source_page,2);
});
test('missing or unsupported locations stay invalid instead of becoming 0,0', () => {
  const row=parseProjectPage('Project: Unknown\nLatitude: 33 degrees 2 minutes\nIn-service year: 2028','test.pdf',1)[0];
  assert(validateDraft(row)); assert.throws(()=>toMapProject(row));
  assert.equal(parseProjectPage('Bridge construction cost $3300000, completion 2027','test.pdf',1).length,0);
  assert(validateDraft({...row,latitude:'',longitude:''}));
  assert(validateDraft({...row,latitude:'91',longitude:'-80'}));
  assert.equal(validateDraft({...row,latitude:'0',longitude:'0'}),null);
});
test('inclusive 25 mile rule, no self pairs, and same project exclusion', () => {
  const row=parseProjectPage('Project: A\nLatitude: 0\nLongitude: 0','test.pdf',1)[0];
  const a=toMapProject(row), b={...a,record_id:'b',project_id:'b',longitude:0.1};
  assert.equal(proximityPairs([a,b]).length,1);
  const exact=milesBetween(a,b);
  assert.equal(proximityPairs([a,b],exact).length,1);
  assert.equal(proximityPairs([a,b],exact-0.000001).length,0);
  assert.equal(proximityPairs([a,{...b,project_id:a.project_id}]).length,0);
  assert.equal(proximityPairs([a,{...b,longitude:1}]).length,0);
  assert.equal(proximityPairs([a]).length,0);
});
