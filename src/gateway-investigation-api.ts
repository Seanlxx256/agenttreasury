import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import { checkInvestigationFreshness, runGatewayInvestigation } from './gateway-investigation-run.js';
import { PaymentError } from './payments.js';
import { createInvestigationCheckpoint, resumeInvestigationCheckpoint } from './gateway-investigation-checkpoints.js';

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
    const refreshExternal=request.body.refreshExternal===true;
    if (process.env.GATEWAY_INVESTIGATION_MODE === 'guided') {
      const id=await createInvestigationCheckpoint(pool,request.params.id,actor,{model,refreshExternal});
      return resumeInvestigationCheckpoint(pool,request.params.id,id,actor);
    }
    const report=await runGatewayInvestigation(pool,request.params.id,{model,refreshExternal});
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
    const freshness=await checkInvestigationFreshness(pool,request.params.id,saved.report.snapshot.fingerprint);
    return {runId:saved.runId,createdAt:saved.createdAt,...saved.report,
      staleNow:freshness.stale,currentFreshness:freshness.status,freshnessCheckedAt:freshness.checkedAt};
  });
  const checkpointParams={type:'object',required:['id','checkpointId'],properties:{...params.properties,checkpointId:params.properties.id}};
  app.get<{Params:{id:string}}>(path+'/checkpoints',{schema:{params}},async(request,reply)=>{
    authenticate(request);reply.header('cache-control','no-store');
    const {rows}=await pool.query(`SELECT id,created_at AS "createdAt",updated_at AS "updatedAt",status,attempts,
      model,refresh_external AS "refreshExternal",run_id::text AS "runId",
      jsonb_array_length(progress->'checks') AS "savedChecks"
      FROM gateway_investigation_checkpoints WHERE request_id=$1 ORDER BY created_at DESC,id DESC LIMIT 20`,[request.params.id]);
    return {checkpoints:rows,limit:20};
  });
  app.get<{Params:{id:string;checkpointId:string}}>(path+'/checkpoints/:checkpointId',{schema:{params:checkpointParams}},async(request,reply)=>{
    authenticate(request);reply.header('cache-control','no-store');
    const {rows:[saved]}=await pool.query(`SELECT id,status,attempts,created_at AS "createdAt",updated_at AS "updatedAt",
      model,refresh_external AS "refreshExternal",actor,last_actor AS "lastActor",snapshot,progress,run_id::text AS "runId"
      FROM gateway_investigation_checkpoints WHERE id=$1 AND request_id=$2`,[request.params.checkpointId,request.params.id]);
    if (!saved) throw new PaymentError(404,'INVESTIGATION_CHECKPOINT_NOT_FOUND');
    return {...saved,advisoryOnly:true,financialAuthority:false};
  });
  app.post<{Params:{id:string;checkpointId:string}}>(path+'/checkpoints/:checkpointId/resume',{
    preHandler:async(request)=>{authenticate(request);},
    schema:{params:checkpointParams,body:{type:'object',additionalProperties:false,properties:{}}},
  },async(request,reply)=>{
    const actor=authenticate(request);reply.header('cache-control','no-store');
    return resumeInvestigationCheckpoint(pool,request.params.id,request.params.checkpointId,actor);
  });
}
