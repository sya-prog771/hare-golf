// ランダムなイレギュラー N 件（既定 10000）でアプリが壊れないか・ルール違反の予定が出ないかを確認する
// 使い方: node tests/fuzz.js [件数]   （Playwright が必要）
const path=require('path');const {chromium}=require('playwright');
const N=+process.argv[2]||10000;
(async()=>{
  const b=await chromium.launch();const pg=await b.newPage();
  const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('file://'+path.resolve(__dirname,'..','index.html'));
  await pg.evaluate(()=>localStorage.clear());await pg.reload();
  const r=await pg.evaluate(n=>new Promise(res=>runFuzz(n,()=>{},(fail,sec)=>res({fail,sec}))),N);
  console.log(`${N}件中 失敗 ${r.fail.length}件（${r.sec.toFixed(1)}秒）`);
  r.fail.slice(0,20).forEach(f=>console.log(`  seed ${f.seed}: ${f.msg}`));
  if(errs.length)console.log('ページエラー:',errs.slice(0,5));
  await b.close();process.exit(r.fail.length||errs.length?1:0);
})();
