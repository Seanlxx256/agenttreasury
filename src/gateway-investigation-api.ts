import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { collectInvestigationSnapshot, runGatewayInvestigation } from './gateway-investigation-run.js';
import { PaymentError } from './payments.js';

export function registerGatewayInvestigation(app:FastifyInstance,pool:Pool,
  authenticate:(request:FastifyRequest)=>'finance'|'operations') {
  const params={type:'object',required:['id'],properties:{id:{type:'string',
    pattern:'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'}}};
  const path='/finance/gateway-purchases/:id/investigation';
  app.post<{Params:{id:string};Body:{refreshExternal?:boolean}}>(path,{
    preHandler:async(request)=>{authenticate(request);},
    schema:{params,body:{type:'object',additionalProperties:false,properties:{refreshExternal:{type:'boolean'}}}},
  },async(request,reply)=>{
    const actor=authenticate(request);
    reply.header('cache-control','no-store');
    const model=process.env.GATEWAY_INVESTIGATION_MODEL || undefined;
    const report=await runGatewayInvestigation(pool,request.params.id,{model,refreshExternal:request.body.refreshExternal===true});
    // Only this append writes; collectors use READ ONLY and tools cannot call
    // payment, signing, delivery recovery, case transitions or refund handlers.
    const {rows:[saved]}=await pool.query(`INSERT INTO gateway_investigation_runs(request_id,actor,model,report)
      VALUES($1,$2,$3,$4) RETURNING id::text AS "runId",created_at AS "createdAt"`,
    [request.params.id,actor,model ?? null,JSON.stringify(report)]);
    return {...saved,...report};
  });
  app.get<{Params:{id:string}}>(path,{schema:{params}},async(request,reply)=>{
    authenticate(request);reply.header('cache-control','no-store');
    const {rows:[saved]}=await pool.query(`SELECT id::text AS "runId",created_at AS "createdAt",report
      FROM gateway_investigation_runs WHERE request_id=$1 ORDER BY id DESC LIMIT 1`,[request.params.id]);
    if (!saved) throw new PaymentError(404,'INVESTIGATION_NOT_FOUND');
    const current=await collectInvestigationSnapshot(pool,request.params.id);
    return {runId:saved.runId,createdAt:saved.createdAt,...saved.report,
      staleNow:current.fingerprint!==saved.report.snapshot.fingerprint,freshnessCheckedAt:current.capturedAt};
  });
}
