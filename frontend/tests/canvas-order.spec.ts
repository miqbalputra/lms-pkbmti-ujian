import {test,expect} from '@playwright/test';
import {canvasRows,canvasOrderPatch} from '../src/forms/canvasOrder';
import type {FormCard,FormDraft,FormSection} from '../src/forms/types';

const a={id:'a',sectionId:'',position:1,deleted:false} as FormCard;
const b={id:'b',sectionId:'s1',position:2,deleted:false} as FormCard;
const c={id:'c',sectionId:'s2',position:3,deleted:false} as FormCard;
const s1={id:'s1',next:'',position:1,deleted:false} as FormSection;
const s2={id:'s2',next:'',position:2,deleted:false} as FormSection;
test('canvas interleaves sections with their cards in visible order',()=>{
  const rows=canvasRows({cards:{a,b,c},sections:{s1,s2}} as FormDraft);
  expect(rows.map(row=>row.id)).toEqual(['a','s1','b','s2','c']);
});
test('moving a card across a section updates position and membership atomically',()=>{
  const result=canvasOrderPatch([a,s1,s2,b,c],'b');
  expect(result.cards?.b).toEqual({position:2,sectionId:'s2'});
  expect(result.cards?.a).toEqual({position:1,sectionId:''});
});
test('moving a section preserves its questions and changes only group order',()=>{
  const result=canvasOrderPatch([a,s2,s1,b,c],'s2');
  expect(result.sections).toEqual({s2:{position:1},s1:{position:2}});
  expect(result).not.toHaveProperty('cards');
});
