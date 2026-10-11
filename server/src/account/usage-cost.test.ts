import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { getCostSnapshot, platformPricing, recordRunUsage } from "./usage-store.js";

test("run usage is recorded per user and cost is estimated from configured prices",async()=>{
  process.env.PLATFORM_AI_PRICE_INPUT_PER_MILLION="1";
  process.env.PLATFORM_AI_PRICE_OUTPUT_PER_MILLION="2";
  process.env.PLATFORM_AI_PRICE_CURRENCY="RUB";
  try{
    const userId="cost-test-"+randomUUID();
    const empty=await getCostSnapshot(userId);
    assert.equal(empty.runs,0);
    assert.equal(empty.costEstimate,0);
    assert.equal(empty.lastRun,null);
    await recordRunUsage(userId,{runId:randomUUID(),projectId:"project-1",model:"model-1",promptTokens:1_000_000,completionTokens:500_000,estimated:false});
    const snapshot=await getCostSnapshot(userId);
    assert.equal(snapshot.runs,1);
    assert.equal(snapshot.promptTokens,1_000_000);
    assert.equal(snapshot.completionTokens,500_000);
    assert.equal(snapshot.exact,true);
    assert.equal(snapshot.pricesConfigured,true);
    assert.equal(snapshot.currency,"RUB");
    assert.equal(snapshot.costEstimate,2);
    assert.equal(snapshot.lastRun?.model,"model-1");
    assert.equal(snapshot.lastRun?.costEstimate,2);
  }finally{
    delete process.env.PLATFORM_AI_PRICE_INPUT_PER_MILLION;
    delete process.env.PLATFORM_AI_PRICE_OUTPUT_PER_MILLION;
    delete process.env.PLATFORM_AI_PRICE_CURRENCY;
  }
});

test("without pricing the snapshot has no money value and users stay isolated",async()=>{
  delete process.env.PLATFORM_AI_PRICE_INPUT_PER_MILLION;
  delete process.env.PLATFORM_AI_PRICE_OUTPUT_PER_MILLION;
  assert.equal(platformPricing(),null);
  const userId="cost-test-"+randomUUID();
  const otherUserId="cost-test-"+randomUUID();
  await recordRunUsage(userId,{runId:randomUUID(),projectId:"project-2",conversationId:"conv-1",model:"model-2",promptTokens:200,completionTokens:100,estimated:true});
  const snapshot=await getCostSnapshot(userId);
  const other=await getCostSnapshot(otherUserId);
  assert.equal(snapshot.runs,1);
  assert.equal(snapshot.exact,false);
  assert.equal(snapshot.pricesConfigured,false);
  assert.equal(snapshot.costEstimate,null);
  assert.equal(snapshot.lastRun?.exact,false);
  assert.equal(other.runs,0);
});
