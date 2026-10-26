import test from 'node:test';
import assert from 'node:assert/strict';
import {attendanceLocation} from '../src/attendance-location.js';
test('GPS requires complete finite coordinates and accepts zero coordinates',()=>{
  for(const value of [null,{}, {latitude:1}, {latitude:91,longitude:0}, {latitude:0,longitude:181}, {latitude:'0',longitude:0}, {latitude:NaN,longitude:0}])assert.equal(attendanceLocation(value,0,0),null);
  assert.equal(attendanceLocation({latitude:0,longitude:0},0,0).distanceMeters,0);
});
test('Saved distance and historical store coordinates take priority',()=>{
  assert.equal(attendanceLocation({latitude:0,longitude:0,distanceMeters:15},20,20).distanceMeters,15);
  assert.equal(attendanceLocation({latitude:0,longitude:0,shopLatitude:0,shopLongitude:0},20,20).distanceMeters,0);
  const fallback=attendanceLocation({latitude:0,longitude:0},'0','1');
  assert(Math.abs(fallback.distanceMeters-111195)<1);
  assert.equal(attendanceLocation({latitude:0,longitude:0},null,null).distanceMeters,null);
});
