import { expect, open, test } from 'nsh/test';
test('a single choice uses the shared composer and advances automatically', async () => {
 const app=await open('./UserInputIntegratedFixture.tsx',{width:800,height:600});
 await expect(app.shows('label:Answer Question')).toBe(false);
 await expect(app.enabled('label:Composer submit')).toBe(false);
 await app.press('label:First'); await app.waitFor('text:{"answer":"one"}');
});
test('custom text supplies the answer through the composer', async () => {
 const app=await open('./UserInputIntegratedFixture.tsx',{width:800,height:600});
 await app.type('label:Composer answer','hello');
 await app.press('label:Composer submit'); await app.waitFor('text:{"answer":"hello"}');
});
