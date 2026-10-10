const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const path=require('path');
const ui=fs.readFileSync(path.join(__dirname,'../src/app-ui.js'),'utf8');
const encoded=ui.match(/const js = Buffer.from\('([^']+)',\s*'base64'\)/)[1];
const s=Buffer.from(encoded,'base64').toString('utf8');
const a=s.indexOf("  const saveButton=document.querySelector('#loanForm");
const b=s.indexOf('  const clearCustomer=',a);
const submit=s.slice(s.indexOf("  document.getElementById('loanForm').onsubmit=async e=>{"),s.indexOf('\nfunction showLoanEditForm'));
let finish,calls=0,form={},button={parentElement:{prepend(){}}},warning;
const ctx={state:{loans:[]},customer:{value:'c1'},document:{querySelector:()=>button,createElement:()=>warning={setAttribute(){}},getElementById:()=>form},loanPayload:()=>({customer_id:'c1'}),api:()=>{calls++;return new Promise(r=>finish=r)},closeModal(){},showNotice(){},loadAll:async()=>{},setView(){}};
vm.createContext(ctx);vm.runInContext(s.slice(a,b)+submit.slice(0,submit.lastIndexOf('\n}')),ctx);
(async()=>{
for(const [status,balance,blocked] of [['PENDING',0,true],['DISBURSED',100,true],['DISBURSED',0,false],['CANCELLED',100,false]]){
ctx.state.loans=[{customer_id:'c1',loan_code:'LN001',lifecycle_status:status,balance}];
assert.equal(vm.runInContext('updateLoanEligibility()',ctx),!blocked);assert.equal(button.disabled,blocked);
}
ctx.state.loans=[];const event={preventDefault(){},currentTarget:form};const first=form.onsubmit(event);await form.onsubmit(event);assert.equal(calls,1);assert.equal(button.disabled,true);finish({});await first;assert.equal(button.disabled,false);console.log('UI eligibility and concurrent double-submit checks passed');
})().catch(e=>{console.error(e);process.exitCode=1});
