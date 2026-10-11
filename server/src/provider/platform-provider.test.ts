import { test } from "node:test";
import assert from "node:assert/strict";
import { getPlatformProviderConfig } from "./platform-provider.js";

const NAMES=["PLATFORM_AI_BASE_URL","PLATFORM_AI_API_KEY","PLATFORM_AI_MODEL","PLATFORM_AI_PROVIDER","AI_BASE_URL","AI_API_KEY","AI_MODEL"];
function clear(){for(const name of NAMES)delete process.env[name];}

test("platform provider requires base URL and model",()=>{
  clear();
  assert.equal(getPlatformProviderConfig(),null);
  process.env.PLATFORM_AI_BASE_URL="https://api.example.com/v1";
  assert.equal(getPlatformProviderConfig(),null);
  process.env.PLATFORM_AI_MODEL="test-model";
  process.env.PLATFORM_AI_API_KEY="test-secret";
  const config=getPlatformProviderConfig();
  assert.equal(config?.baseUrl,"https://api.example.com/v1");
  assert.equal(config?.model,"test-model");
  assert.equal(config?.token,"test-secret");
  clear();
});

test("legacy AI_* names remain supported as aliases and PLATFORM_AI_* wins",()=>{
  clear();
  process.env.AI_BASE_URL="https://legacy.example.com/v1";
  process.env.AI_MODEL="legacy-model";
  assert.equal(getPlatformProviderConfig()?.model,"legacy-model");
  process.env.PLATFORM_AI_BASE_URL="https://platform.example.com/v1";
  process.env.PLATFORM_AI_MODEL="platform-model";
  const config=getPlatformProviderConfig();
  assert.equal(config?.baseUrl,"https://platform.example.com/v1");
  assert.equal(config?.model,"platform-model");
  clear();
});
