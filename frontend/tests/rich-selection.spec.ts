import {test,expect} from '@playwright/test';
import {shiftedSelection} from '../src/forms/richTextDom';

test('remote insertion before a selection preserves its text and backwards direction',()=>{
  expect(shiftedSelection({start:3,end:5,backwards:true},'abcDEF','XXabcDEF')).toEqual({start:5,end:7,backwards:true});
});
test('remote deletion clamps an overlapping selection without moving it past text',()=>{
  expect(shiftedSelection({start:2,end:6},'abcdefghi','abghi')).toEqual({start:2,end:2});
});
test('format-only updates do not move the selection',()=>{
  expect(shiftedSelection({start:1,end:4},'teks','teks')).toEqual({start:1,end:4});
});
