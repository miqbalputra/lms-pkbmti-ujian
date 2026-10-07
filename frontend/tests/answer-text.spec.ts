import { test, expect } from '@playwright/test';
import { readableAnswer } from '../src/answerText';

test('saved responses show labels, boolean values and zero without exposing keys', () => {
  expect(readableAnswer({type:'benar_salah',config:{statements:[{id:'s',text:'Air laut tawar',correct:false}]}},{s:false})).toBe('Air laut tawar: Salah');
  expect(readableAnswer({type:'rating'},0)).toBe('0');
  expect(readableAnswer({type:'pg_kompleks',config:{choices:[{id:'a',text:'Pilihan A'},{id:'b',text:'Pilihan B'}]}},['a','__other__:Pendapat saya'])).toBe('Pilihan A, Pendapat saya');
});
test('ordering and matching responses use readable text', () => {
  expect(readableAnswer({type:'susun_urutan',config:{choices:[{id:'a',text:'Mulai'},{id:'b',text:'Selesai'}]}},['a','b'])).toBe('Mulai → Selesai');
  expect(readableAnswer({type:'menjodohkan',config:{left:[{id:'a',text:'Kucing'}],right:[{id:'b',text:'Ikan'}]}},{a:'b'})).toBe('Kucing: Ikan');
});
test('file and empty responses never display object coercions', () => {
  expect(readableAnswer({type:'unggah_berkas'},[{id:'f',name:'jawaban.pdf'}])).toBe('jawaban.pdf');
  for (const value of [null,undefined,'',[],{}]) expect(readableAnswer({type:'isian_singkat'},value)).toBe('Belum dijawab');
});
