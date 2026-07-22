import { ServiceNowAdapter } from './adapters/servicenow';
import { SalesforceAdapter } from './adapters/salesforce';
import { GeminiLLMClient } from './llm/llm_client';
import { GeminiEmbeddingsClient } from './llm/embeddings_client';
import { VectorStore } from './core/vector_store';
import { UniversalSchemaDiscoveryAgent } from './core/universal_schema_discovery_agent';
import {
  ControlEffectivenessAgent,
  InherentAssessmentAgent,
  RiskControlMappingAgent
} from './core/agents';
import { withTrace } from './core/observability';

export interface Env {
  GEMINI_API_KEY?: string;
  SERVICENOW_INSTANCE_URL?: string;
  SERVICENOW_USERNAME?: string;
  SERVICENOW_PASSWORD?: string;
  SERVICENOW_USE_LIVE?: string;
  SALESFORCE_INSTANCE_URL?: string;
  SALESFORCE_CLIENT_ID?: string;
  SALESFORCE_CLIENT_SECRET?: string;
  [key: string]: any;
}

// CORS headers for cross-origin calls (e.g. ServiceNow UI Actions / Web Dashboards)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, X-ServiceNow-Source',
  'Access-Control-Max-Age': '86400'
};

function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      ...corsHeaders
    }
  });
}

function syncEnv(env: Env) {
  for (const key of Object.keys(env)) {
    if (typeof env[key] === 'string') {
      process.env[key] = env[key];
    }
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: any): Promise<Response> {
    syncEnv(env);

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // Handle CORS preflight
    if (method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders
      });
    }

    try {
      const llmClient = new GeminiLLMClient();
      const servicenowAdapter = new ServiceNowAdapter();
      const salesforceAdapter = new SalesforceAdapter();

      // Health Check
      if (path === '/' || path === '/health') {
        return jsonResponse({
          status: 'online',
          platform: 'Cloudflare Worker Edge Runtime',
          service: 'GRC Agnostic AI Agent Backend',
          time: new Date().toISOString(),
          config: {
            hasGeminiKey: !!process.env.GEMINI_API_KEY,
            hasSnUrl: !!process.env.SERVICENOW_INSTANCE_URL,
            hasSnUser: !!process.env.SERVICENOW_USERNAME,
            hasSnPass: !!process.env.SERVICENOW_PASSWORD,
            useLive: process.env.SERVICENOW_USE_LIVE,
            snUrl: process.env.SERVICENOW_INSTANCE_URL || 'NOT SET'
          }
        });
      }

      // ServiceNow Live Connection Test
      if (path === '/api/test-connection' && method === 'GET') {
        const instanceUrl = process.env.SERVICENOW_INSTANCE_URL || '';
        const username = process.env.SERVICENOW_USERNAME || '';
        const password = process.env.SERVICENOW_PASSWORD || '';
        const useLive = process.env.SERVICENOW_USE_LIVE;

        if (!instanceUrl || !username || !password) {
          return jsonResponse({
            success: false,
            error: 'ServiceNow secrets not configured in Cloudflare',
            missing: {
              SERVICENOW_INSTANCE_URL: !instanceUrl,
              SERVICENOW_USERNAME: !username,
              SERVICENOW_PASSWORD: !password,
              SERVICENOW_USE_LIVE: !useLive
            }
          });
        }

        try {
          const base64 = btoa(`${username}:${password}`);
          const url = `${instanceUrl.replace(/\/$/, '')}/api/now/table/sn_risk_risk?sysparm_limit=1`;
          const response = await fetch(url, {
            headers: {
              'Authorization': `Basic ${base64}`,
              'Accept': 'application/json'
            }
          });

          if (response.ok) {
            const data: any = await response.json();
            return jsonResponse({
              success: true,
              message: 'ServiceNow connection successful!',
              instanceUrl,
              useLive,
              riskRecordsFound: data?.result?.length || 0
            });
          } else {
            return jsonResponse({
              success: false,
              error: `ServiceNow returned HTTP ${response.status}`,
              hint: response.status === 401 ? 'Check username/password' : 'Check instance URL'
            });
          }
        } catch (err: any) {
          return jsonResponse({ success: false, error: err.message });
        }
      }

      // Metadata endpoint
      if (path === '/api/platforms' && method === 'GET') {
        return jsonResponse({
          platforms: [
            { id: 'servicenow', name: 'ServiceNow GRC', description: 'Enterprise Risk & Compliance Workspace' },
            { id: 'salesforce', name: 'Salesforce GRC (Custom)', description: 'Salesforce Custom GRC Cloud Objects' }
          ],
          agents: [
            { id: 'control-effectiveness', name: 'Control Effectiveness Agent', description: 'Batch assesses control effectiveness against test evidence and audit runs.' },
            { id: 'inherent-assessment', name: 'Inherent Assessment Agent', description: 'Evaluates inherent factors (PII sensitivity, threat model) using guidance rubrics.' },
            { id: 'risk-control-mapping', name: 'Risk-Control Mapping Agent', description: 'Analyses entity risks and maps relevant mitigating controls from library.' }
          ]
        });
      }

      // Specialized ServiceNow UI Action Trigger Endpoint
      if (path === '/api/servicenow/trigger-agent' && method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const targetId = body.targetId || body.riskSysId || body.sys_id;
        const agent = body.agent || body.agentType || 'risk-control-mapping';
        const platform = body.platform || 'servicenow';

        if (!targetId) {
          return jsonResponse({
            success: false,
            error: 'Missing required parameter: targetId or riskSysId'
          }, 400);
        }

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          logs.push(args.join(' '));
          originalLog(...args);
        };

        try {
          let result: any;
          let traceId = '';

          await withTrace('servicenow-button-trigger', { platform, agent, targetId }, async () => {
            if (agent === 'risk-control-mapping') {
              const coreAgent = new RiskControlMappingAgent(servicenowAdapter, llmClient);
              result = await coreAgent.execute(targetId);
            } else if (agent === 'control-effectiveness') {
              const coreAgent = new ControlEffectivenessAgent(servicenowAdapter, llmClient);
              result = await coreAgent.execute(targetId);
            } else if (agent === 'inherent-assessment') {
              const coreAgent = new InherentAssessmentAgent(servicenowAdapter, llmClient);
              result = await coreAgent.execute(targetId);
            } else {
              throw new Error(`Unsupported agent type: ${agent}`);
            }
          });

          console.log = originalLog;

          let summary = 'AI Agent execution finished.';
          if (result) {
            if (result.message) {
              summary = result.message;
            } else if (result.overallJustification) {
              summary = result.overallJustification;
            } else if (result.details?.justification) {
              summary = result.details.justification;
            } else if (result.summary) {
              summary = result.summary;
            } else if (Array.isArray(result) && result.length > 0) {
              summary = `Evaluated ${result.length} assessment factors.`;
            }
            // Prepend success/failure indicator
            if (result.success === false) {
              summary = '⚠️ ' + summary;
            }
          }

          return jsonResponse({
            success: true,
            platform: 'servicenow',
            agent,
            targetId,
            summary,
            result,
            logs
          });
        } catch (err: any) {
          console.log = originalLog;
          return jsonResponse({
            success: false,
            error: err.message || 'Error executing AI agent',
            logs
          }, 500);
        }
      }

      // Universal Run Agent Endpoint
      if (path === '/api/run-agent' && method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const { platform, agent, targetId } = body;

        if (!platform || !agent || !targetId) {
          return jsonResponse({ error: 'Missing parameters platform, agent, or targetId.' }, 400);
        }

        let adapter;
        if (platform === 'servicenow') adapter = servicenowAdapter;
        else if (platform === 'salesforce') adapter = salesforceAdapter;
        else return jsonResponse({ error: `Unsupported platform adapter: ${platform}` }, 400);

        const logs: string[] = [];
        const originalLog = console.log;
        console.log = (...args: any[]) => {
          logs.push(args.join(' '));
          originalLog(...args);
        };

        try {
          let result;
          if (agent === 'control-effectiveness') {
            result = await new ControlEffectivenessAgent(adapter, llmClient).execute(targetId);
          } else if (agent === 'inherent-assessment') {
            result = await new InherentAssessmentAgent(adapter, llmClient).execute(targetId);
          } else if (agent === 'risk-control-mapping') {
            result = await new RiskControlMappingAgent(adapter, llmClient).execute(targetId);
          } else {
            console.log = originalLog;
            return jsonResponse({ error: `Unsupported agent action: ${agent}` }, 400);
          }

          console.log = originalLog;
          return jsonResponse({
            success: true,
            agent,
            platform,
            result,
            logs
          });
        } catch (error: any) {
          console.log = originalLog;
          return jsonResponse({
            success: false,
            error: error.message,
            logs
          }, 500);
        }
      }

      // ServiceNow Risks Listing
      if (path === '/api/platforms/servicenow/risks' && method === 'GET') {
        const risks = await servicenowAdapter.getAllRisks();
        return jsonResponse({ success: true, risks });
      }

      // ServiceNow Assessments Listing
      if (path === '/api/platforms/servicenow/assessments' && method === 'GET') {
        const agentParam = url.searchParams.get('agent') || undefined;
        const instances = await servicenowAdapter.getAllAssessmentInstances(agentParam);
        return jsonResponse({ success: true, instances });
      }

      // Schema Discovery
      if (path === '/api/schema-discovery' && method === 'POST') {
        const body: any = await request.json().catch(() => ({}));
        const { rawMetadata, platformName } = body;
        if (!rawMetadata) return jsonResponse({ error: 'Missing parameter rawMetadata.' }, 400);

        const embeddingsClient = new GeminiEmbeddingsClient();
        const vectorStore = new VectorStore();
        const universalDiscoveryAgent = new UniversalSchemaDiscoveryAgent(llmClient, embeddingsClient, vectorStore);

        const result = await universalDiscoveryAgent.executeFromPastedMetadata(platformName || 'Custom GRC Platform', rawMetadata);
        return jsonResponse({ success: true, result });
      }

      return jsonResponse({ error: `Route not found: ${method} ${path}` }, 404);
    } catch (globalErr: any) {
      return jsonResponse({
        success: false,
        error: globalErr.message || 'Internal Cloudflare Worker Error'
      }, 500);
    }
  }
};
