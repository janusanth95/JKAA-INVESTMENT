const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(path.join(__dirname,'../src/routes/loans.js'),'utf8');
const start=source.indexOf("loansRouter.put(\n  '/:id',");
assert.ok(start>=0,'Pending edit route must be mounted');
const end=source.indexOf('const cancelLoanSchema',start);
async function run(status,failGuarantor=false){
 let handler,body,err,committed=false,rolledBack=false;const calls=[];
 const client={query:async(sql,params)=>{
  calls.push({sql,params});
  if(sql.startsWith('SELECT id'))return {rowCount:status?1:0,rows:status?[{id:'loan',lifecycle_status:status}]:[]};
  if(sql.startsWith('UPDATE loans'))return {rowCount:1,rows:[{id:'loan',principal:params[1],interest_rate:params[2]}]};
  if(sql.startsWith('INSERT INTO loan_guarantors')&&failGuarantor)throw new Error('guarantor failure');
  return {rows:[],rowCount:1};
 }};
 const context={loansRouter:{put:(route,permission,fn)=>{assert.equal(route,'/:id');assert.equal(permission,'LOAN_EDIT');handler=fn}},requirePermission:x=>x,updatePendingLoanSchema:{parse:x=>x},withTransaction:async(actor,work)=>{assert.equal(actor,'admin');try{const result=await work(client);committed=true;return result}catch(e){rolledBack=true;throw e}}};
 vm.runInNewContext(source.slice(start,end),context);
 await handler({auth:{user_id:'admin'},params:{id:'loan'},body:{principal:75000,interest_rate:34,loan_type:'WEEKLY',installment_count:28,repayment_start_date:'2026-10-12',guarantors:[{name:'Test Guarantor',nic:'12345'}]}},{json:x=>body=x},e=>err=e);
 return {calls,body,err,committed,rolledBack};
}
(async()=>{
 const good=await run('PENDING');assert.equal(good.body.loan.principal,75000);assert.equal(good.committed,true);assert.ok(good.calls[0].sql.includes('FOR UPDATE'));assert.equal(good.calls.filter(x=>x.sql.startsWith('UPDATE loans')).length,1);assert.equal(good.calls.filter(x=>x.sql.startsWith('INSERT INTO loan_guarantors')).length,1);
 for(const status of ['DISBURSED','CANCELLED',null]){const r=await run(status);assert.equal(r.err.code,'P0001');assert.equal(r.calls.length,1);assert.equal(r.rolledBack,true)}
 const failed=await run('PENDING',true);assert.equal(failed.committed,false);assert.equal(failed.rolledBack,true);assert.equal(failed.err.message,'guarantor failure');
 console.log('Pending loan edit: save, status protection, missing loan and transaction failure passed');
})().catch(e=>{console.error(e);process.exitCode=1});
