import { BaseGRCAdapter } from '../adapters/base';
import { BaseLLMClient } from '../llm/llm_client';
import { Risk, Control, TestEvidence, Factor, InherentAssessmentResult, ControlEffectivenessResult, MappingResult } from './models';

// ============================================================================
// Helper: Determinstic Evidence Fingerprinting
// ============================================================================
function buildEvidenceFingerprint(evidence: TestEvidence): string {
  const parts: string[] = [evidence.sysId];
  
  // Cast and read internal tests sub-evidence if present
  const tests: any[] = (evidence as any).tests || [];
  for (const t of tests) {
    const openCount = t.openIssues?.length || 0;
    const closedCount = t.closedIssues || 0;
    parts.push(
      [
        t.name,
        t.state,
        t.effectiveness,
        t.status,
        t.latestResult,
        t.resultDate,
        `open:${openCount}`,
        `closed:${closedCount}`
      ].join('~')
    );
  }
  
  return parts.sort().join('||');
}

// ============================================================================
// 1. Control Effectiveness Agent
// ============================================================================
export class ControlEffectivenessAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) return { success: false, message: 'Assessment instance not found', details: [] };

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) return { success: false, message: 'Linked risk not found', details: [] };

    // Use the resolved instance id (see InherentAssessmentAgent note).
    const rows = await this.adapter.getControlFactorRows(inst.sysId);
    if (rows.length === 0) {
      return { success: false, message: 'No control-linked responses found', details: [] };
    }

    const priorInstanceSysId = await this.adapter.getPriorClosedAssessment(inst.riskSysId, instanceSysId);
    const results: any[] = [];
    const toAssess: any[] = [];

    for (const row of rows) {
      if (!row.controlSysId) continue;
      const evidence = await this.adapter.getControlEvidence(row.controlSysId);
      const fingerprint = buildEvidenceFingerprint(evidence);

      // Check if we can carry forward a prior closed answer
      if (priorInstanceSysId) {
        const prior = await this.adapter.getPriorControlAnswer(priorInstanceSysId.sysId, row.controlSysId, row.factorSysId);
        if (prior && prior.fingerprint === fingerprint && prior.factorResponse) {
          const carriedScore = parseInt(prior.factorResponse, 10);
          await this.adapter.writeControlEffectiveness(
            row.sysId,
            carriedScore,
            prior.ratingLabel,
            `📋 WISSDASENSE — Carried forward. No changes in control or tests since last assessment.\nRating: ${prior.ratingLabel}\nPrior reasoning: ${prior.comments}`,
            prior.comments,
            prior.comments,
            fingerprint
          );
          results.push({ control: row.controlName, action: 'copied', rating: prior.ratingLabel });
          continue;
        }
      }

      // If no match, queue for live AI assessment
      toAssess.push({
        rowSysId: row.sysId,
        controlSysId: row.controlSysId,
        controlName: row.controlName,
        factorSysId: row.factorSysId,
        evidence,
        fingerprint
      });
    }

    if (toAssess.length > 0) {
      // Build prompts and assess in a single structured batch call
      const prompt = this.buildBatchPrompt(risk, toAssess);
      const systemInstruction = 'You are WissdaSense, a GRC control-effectiveness assessment expert. Evaluate controls against risk test evidence.';
      
      const schema = {
        type: 'OBJECT',
        properties: {
          assessments: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                index: { type: 'INTEGER' },
                rating: { type: 'STRING' },
                justification: { type: 'STRING' }
              },
              required: ['index', 'rating', 'justification']
            }
          }
        },
        required: ['assessments']
      };

      const rawResponse = await this.llm.generateStructuredOutput<{ assessments: ControlEffectivenessResult[] }>(prompt, systemInstruction, schema);
      const assessmentMap = new Map<number, ControlEffectivenessResult>();
      rawResponse.assessments.forEach(item => assessmentMap.set(item.index, item));

      for (let i = 0; i < toAssess.length; i++) {
        const item = toAssess[i];
        const evalResult = assessmentMap.get(i + 1);

        if (!evalResult) {
          await this.adapter.writeFailure(item.rowSysId, 'AI batch response item missing.');
          results.push({ control: item.controlName, action: 'failed', error: 'no response' });
          continue;
        }

        const factorDetails = await this.adapter.getFactorChoices(item.factorSysId);
        if (!factorDetails) {
          await this.adapter.writeFailure(item.rowSysId, 'Factor rating scale not configured.');
          continue;
        }

        // Fuzzy match the rating string to a score
        let score = factorDetails.choiceMap[evalResult.rating];
        if (score === undefined) {
          // Fallback fuzzy match
          const target = evalResult.rating.toLowerCase().trim();
          for (const key of Object.keys(factorDetails.choiceMap)) {
            if (key.toLowerCase().trim() === target) {
              score = factorDetails.choiceMap[key];
              break;
            }
          }
        }

        if (score === undefined) {
          // Default to lowest score
          const labels = Object.keys(factorDetails.choiceMap);
          const lowestLabel = labels.reduce((a, b) => factorDetails.choiceMap[a] < factorDetails.choiceMap[b] ? a : b);
          score = factorDetails.choiceMap[lowestLabel];
          evalResult.rating = lowestLabel;
          evalResult.justification = `WissdaSense returned out-of-scale rating. Defaulted to lowest option (${lowestLabel}). Original rationale: ${evalResult.justification}`;
        }

        const controlLevelIssues: any[] = item.evidence.openIssues || [];
        const tests: any[] = (item.evidence as any).tests || [];
        const testLevelIssues = tests.reduce((sum: number, t: any) => sum + (t.openIssues?.length || 0), 0);
        const testCount = tests.length;

        // Confidence level
        let confidence = 'Grounded';
        if (testCount === 0 && controlLevelIssues.length === 0) {
          confidence = 'Estimated';
        }

        const formattedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);

        // --- Build test detail strings ---
        const testDetailHuman = tests.length > 0
          ? tests.map((t: any) => `"${t.name}" (${t.number}, status: ${t.state || 'Unknown'}, effectiveness: ${t.effectiveness || 'Unknown'})`).join('; ')
          : 'none';

        const testDetailTech = tests.length > 0
          ? tests.map((t: any) => `"${t.name}" (${t.number}, status: ${t.state || 'Unknown'}, effectiveness: ${t.effectiveness || 'Unknown'})`).join('; ')
          : 'none';

        // --- Build associated issues strings ---
        const allOpenIssues: any[] = [
          ...controlLevelIssues,
          ...tests.flatMap((t: any) => t.openIssues || [])
        ];
        const issueDetailHuman = allOpenIssues.length > 0
          ? allOpenIssues.map(i => `${i.number}: ${i.desc}`).join('; ')
          : 'none found';
        const issueDetailTech = issueDetailHuman;

        // --- Prior assessment ---
        const priorLine = priorInstanceSysId
          ? `prior closed assessment ${priorInstanceSysId.number} was searched and re-evaluated because control/test data changed since then`
          : 'no prior closed assessment found for this risk';
        const priorLineTech = priorInstanceSysId
          ? `sn_risk_advanced_risk_assessment_instance_response (prior closed assessment ${priorInstanceSysId.number}) and re-evaluated because control/test data changed since then`
          : 'sn_risk_advanced_risk_assessment_instance — no prior closed assessment found for this risk';

        // ============================================================
        // 1. Human-readable comment → additional_comments
        // ============================================================
        const summary = [
          '🔍 WISSDASENSE INVESTIGATION — Control Effectiveness Assessment',
          '',
          `Rating: ${evalResult.rating}`,
          `Confidence: ${confidence}`,
          '',
          'WHAT WAS SEARCHED:',
          `  1. Control details — searched the control record and found: "${item.controlName}"`,
          `  2. Control tests — searched the Control Tests related list on the control and found ${testCount} record${testCount !== 1 ? 's' : ''}: ${testDetailHuman}`,
          `  3. Associated issues — searched the Associated Issues tab on the control and found ${allOpenIssues.length} record${allOpenIssues.length !== 1 ? 's' : ''} not yet Closed Complete: ${issueDetailHuman}`,
          `  4. Prior assessment history — ${priorLine}`,
          '',
          'CONCLUSION:',
          evalResult.justification,
          '',
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('\n');

        // ============================================================
        // 2. Technical audit trail → u_rationale_auditing_purpose (HTML rich text field)
        // ============================================================
        const auditTrail = [
          `🔍 WISSDASENSE INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Control Effectiveness Assessment`,
          `Rating: ${evalResult.rating}`,
          `Confidence: ${confidence}`,
          `WHAT WAS SEARCHED (table-level detail):`,
          `&nbsp;&nbsp;1. Control details — searched sn_compliance_control (control record) and found: "${item.controlName}"`,
          `&nbsp;&nbsp;2. Control tests — searched sn_audit_control_test (Control Tests related list on the control) and found ${testCount} record${testCount !== 1 ? 's' : ''}: ${testDetailTech}`,
          `&nbsp;&nbsp;3. Associated issues — searched sn_grc_issue (Issue Management module, same records as the Associated Issues tab on the control) and found ${allOpenIssues.length} record${allOpenIssues.length !== 1 ? 's' : ''} not yet Closed Complete: ${issueDetailTech}`,
          `&nbsp;&nbsp;4. Prior assessment history — searched ${priorLineTech}`,
          `CONCLUSION:`,
          evalResult.justification,
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('<br><br>').replace(
          // Add single <br> between Rating and Confidence (they should sit together)
          `Rating: ${evalResult.rating}<br><br>Confidence: ${confidence}`,
          `Rating: ${evalResult.rating}<br>Confidence: ${confidence}`
        );

        await this.adapter.writeControlEffectiveness(
          item.rowSysId,
          score,
          evalResult.rating,
          evalResult.justification,
          summary,
          auditTrail,
          item.fingerprint
        );

        results.push({ control: item.controlName, action: 'assessed', rating: evalResult.rating });
      }
    }

    return {
      success: true,
      message: `Processed ${results.length} control assessment(s).`,
      details: results
    };
  }

  private buildBatchPrompt(risk: Risk, batch: any[]): string {
    const blocks = batch.map((item, idx) => {
      const tests: any[] = item.evidence.tests || [];
      const controlOpenIssues: any[] = item.evidence.openIssues || [];

      const testBlock = tests.length === 0
        ? '    No control tests recorded for this control.'
        : tests.map(t => {
            let line = `    - Test "${t.name}": status=${t.state}, effectiveness=${t.effectiveness || 'none'}, health=${t.status || 'n/a'}`;
            if (t.latestResult) line += `, latest result=${t.latestResult}`;
            if (t.openIssues?.length) line += `, OPEN ISSUES (test-level): ${t.openIssues.map((oi: any) => oi.desc || oi.number).join('; ')}`;
            return line;
          }).join('\n');

      const issueBlock = controlOpenIssues.length > 0
        ? `    OPEN ISSUES (control-level): ${controlOpenIssues.map((oi: any) => oi.desc || oi.number).join('; ')}`
        : '    No direct open issues on this control.';

      return `[${idx + 1}] CONTROL: ${item.controlName}\n    Description: ${item.evidence.latestResult || 'N/A'}\n    Control-level issues:\n${issueBlock}\n    Test evidence:\n${testBlock}`;
    }).join('\n\n');

    const entityLabel = this.adapter.getEntityLabel();
    return [
      `RISK:`,
      `Name: ${risk.name}`,
      `Description: ${risk.description}`,
      `${entityLabel}: ${risk.profileName}`,
      '',
      `CONTROLS TO ASSESS:`,
      blocks,
      '',
      'For EACH control, select exactly one rating from: Satisfactory, Needs Improvement, Weak.',
      'If a control has NO test evidence, select the WEAKEST rating and justify citing lack of audits.',
      'Open issues or failed tests significantly degrade rating.',
      'Format output in JSON index matching input.'
    ].join('\n');
  }
}

// ============================================================================
// 2. Inherent Assessment Agent
// ============================================================================
export class InherentAssessmentAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(instanceSysId: string): Promise<{ success: boolean; message: string; details: any[] }> {
    const inst = await this.adapter.getAssessmentInstance(instanceSysId);
    if (!inst) return { success: false, message: 'Assessment instance not found', details: [] };

    const risk = await this.adapter.getRisk(inst.riskSysId);
    if (!risk) return { success: false, message: 'Linked risk not found', details: [] };

    // Use the RESOLVED instance id — for create-on-demand platforms
    // (Salesforce inherent flow) the caller passes a risk id and
    // getAssessmentInstance returns the freshly created assessment.
    const factors = await this.adapter.getAnswerableManualRows(inst.sysId);
    if (factors.length === 0) {
      return { success: false, message: 'No answerable factors found', details: [] };
    }

    // Query active unresolved issues on the entity/business unit
    const entityIssues = await this.adapter.getEntityIssues(risk.profileSysId || '');

    const results: any[] = [];
    const systemInstruction = 'You are WissdaSense, an inherent risk factor evaluator. Review risk definitions, guidance, and issues to select correct scores.';

    const entityLabel = this.adapter.getEntityLabel();
    const isSalesforce = this.adapter.getPlatformName() === 'salesforce';

    for (const factor of factors) {
      const prompt = [
        `RISK:`,
        `Name: ${risk.name}`,
        `Description: ${risk.description}`,
        `${entityLabel}: ${risk.profileName}`,
        '',
        `FACTOR: ${factor.factorName}`,
        `Factor Guidance: ${factor.guidance}`,
        `Active Issues on ${entityLabel}:\n${entityIssues.length > 0 ? entityIssues.map(i => ` - ${i.number ? i.number + ': ' : ''}${i.desc} (State: ${i.state})`).join('\n') : 'No open issues.'}`,
        '',
        `Valid Choices: ${factor.choiceList.join(', ')}`,
        'Evaluate the risk factor. Determine if active issues influence the rating and justify referencing the guidance.'
      ].join('\n');

      const schema = {
        type: 'OBJECT',
        properties: {
          rating: { type: 'STRING' },
          issue_relevant: { type: 'BOOLEAN' },
          justification: { type: 'STRING' }
        },
        required: ['rating', 'issue_relevant', 'justification']
      };

      const response = await this.llm.generateStructuredOutput<InherentAssessmentResult>(prompt, systemInstruction, schema);
      
      let score = factor.choiceMap[response.rating];
      if (score === undefined) {
        // Fallback fuzzy
        const target = response.rating.toLowerCase().trim();
        for (const key of Object.keys(factor.choiceMap)) {
          if (key.toLowerCase().trim() === target) {
            score = factor.choiceMap[key];
            break;
          }
        }
      }

      if (score !== undefined) {
        // --- Build structured WISSDASENSE comment ---
        const formattedDate = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const issueCount = entityIssues.length;

        // Confidence label
        let confidence: string;
        if (issueCount === 0) {
          confidence = isSalesforce ? 'Estimated (no business unit issue data available)' : 'Estimated (no entity issue data available)';
        } else if (response.issue_relevant) {
          confidence = isSalesforce ? 'Partly grounded (informed by relevant business unit issue(s))' : 'Partly grounded (informed by relevant entity issue(s))';
        } else {
          confidence = isSalesforce ? 'Estimated (business unit issues found but none relevant to this factor)' : 'Estimated (entity issues found but none relevant to this factor)';
        }

        // Issue relevance line
        const issueRelevanceLine = issueCount === 0
          ? (isSalesforce ? 'no issues found on the business unit' : 'no issues found on the entity')
          : response.issue_relevant
            ? `${issueCount} unresolved issue(s) found — at least one was identified as relevant to this factor`
            : `none of the ${issueCount} unresolved issue(s) were identified as relevant to this specific factor`;

        const entitySearchLabel = isSalesforce ? 'Business Unit' : 'Entity';
        const searchTableLabel = isSalesforce ? "Business Unit's Downstream Issues related list" : "entity's Downstream Issues related list";
        const techSearchTableLabel = isSalesforce
          ? 'grc__Issue__c (unresolved issues related to grc__Business_Unit__c)'
          : 'sn_grc_m2m_issue_to_entity (Downstream Issues related list on the entity) and sn_grc_issue';

        const comment = [
          '🔍 WISSDASENSE INVESTIGATION — Inherent Risk Factor Assessment',
          '',
          `Rating: ${response.rating}`,
          `Confidence: ${confidence}`,
          '',
          'WHAT WAS SEARCHED:',
          `  1. ${entitySearchLabel} issues — searched the ${searchTableLabel}; found ${issueCount} unresolved issue${issueCount !== 1 ? 's' : ''} not Closed Complete`,
          `  2. Relevant issues — ${issueRelevanceLine}`,
          '',
          'CONCLUSION:',
          response.justification,
          '',
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('\n');

        // Issue relevance tech line (for audit trail — includes issue numbers/desc if available)
        const issueRelevanceTechLine = issueCount === 0
          ? (isSalesforce ? 'no issues found on the business unit' : 'no issues found on the entity')
          : response.issue_relevant
            ? `${issueCount} unresolved issue(s) identified as relevant to this factor: ${entityIssues.map(i => `${i.number ? i.number + ' – ' : ''}"${i.desc}"`).join('; ')}`
            : `none of the ${issueCount} unresolved issue(s) were identified as relevant to this specific factor — issues concern areas not directly tied to this factor's guidance`;

        // ============================================================
        // 2. HTML audit trail → u_rationale_auditing_purpose
        // ============================================================
        const auditTrail = [
          `🔍 WISSDASENSE INVESTIGATION (TECHNICAL / AUDIT TRAIL) — Inherent Risk Factor Assessment`,
          `Rating: ${response.rating}`,
          `Confidence: ${confidence}`,
          `WHAT WAS SEARCHED (table-level detail):`,
          `&nbsp;&nbsp;1. ${entitySearchLabel} issues — searched ${techSearchTableLabel}; found ${issueCount} unresolved issue${issueCount !== 1 ? 's' : ''} not Closed Complete`,
          `&nbsp;&nbsp;2. Relevant issues — ${issueRelevanceTechLine}`,
          `CONCLUSION:`,
          response.justification,
          `Model: gemini-3.5-flash (WissdaSense) · Assessed: ${formattedDate}`
        ].join('<br><br>').replace(
          `Rating: ${response.rating}<br><br>Confidence: ${confidence}`,
          `Rating: ${response.rating}<br>Confidence: ${confidence}`
        ).replace(
          `CONCLUSION:<br><br>${response.justification}`,
          `CONCLUSION:<br>${response.justification}`
        );

        await this.adapter.writeInherentFactor(
          factor.sysId,
          score,
          response.rating,
          response.justification,
          comment,
          auditTrail
        );
        results.push({ factor: factor.factorName, rating: response.rating, score });
      } else {
        await this.adapter.writeFailure(factor.sysId, `Invalid choice returned by AI: ${response.rating}`);
        results.push({ factor: factor.factorName, rating: null, error: 'invalid rating selection' });
      }
    }

    return {
      success: true,
      message: `Assessed ${results.length} inherent factors.`,
      details: results
    };
  }
}

// ============================================================================
// 3. Risk-Control Mapping Agent
// ============================================================================
export class RiskControlMappingAgent {
  constructor(private adapter: BaseGRCAdapter, private llm: BaseLLMClient) {}

  async execute(riskSysId: string): Promise<{ success: boolean; message: string; details: any }> {
    const risk = await this.adapter.getRisk(riskSysId);
    if (!risk) return { success: false, message: 'Risk not found', details: null };

    const entityLabel = this.adapter.getEntityLabel();
    const controls = await this.adapter.getControlsForEntity(risk.profileSysId || '');
    if (controls.length === 0) {
      return { success: false, message: `No controls available for ${entityLabel.toLowerCase()}`, details: null };
    }

    const prompt = [
      `RISK:`,
      `Name: ${risk.name}`,
      `Description: ${risk.description}`,
      `${entityLabel}: ${risk.profileName}`,
      '',
      `CANDIDATE CONTROLS (${controls.length} total from this ${entityLabel}):`,
      controls.map((c, idx) => `[${idx + 1}] Name: ${c.name} | Category: ${c.category || 'General'} | Desc: ${c.description}`).join('\n'),
      '',
      'TASK:',
      '1. Select ALL controls that meaningfully mitigate this specific risk.',
      '2. For EVERY control NOT selected, provide a concise rejection reason explaining why it does NOT meet the business criteria for this risk.',
      '3. Provide overall justification, gaps, and specific recommendations.'
    ].join('\n');

    const systemInstruction = 'You are a GRC Compliance mapping architect. Analyze risks and select mapping control indexes. For every rejected control, explain why it does not address the business criteria of this specific risk.';
    
    const schema = {
      type: 'OBJECT',
      properties: {
        match: { type: 'BOOLEAN' },
        matches: {
          type: 'ARRAY',
          description: 'Controls that SHOULD be mapped — they address this risk.',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              reason: { type: 'STRING', description: 'Why this control mitigates the risk' }
            },
            required: ['index', 'reason']
          }
        },
        rejected: {
          type: 'ARRAY',
          description: 'Controls that should NOT be mapped — they do not meet business criteria for this risk.',
          items: {
            type: 'OBJECT',
            properties: {
              index: { type: 'INTEGER' },
              reason: { type: 'STRING', description: 'Why this control does NOT mitigate the risk' }
            },
            required: ['index', 'reason']
          }
        },
        overall_justification: { type: 'STRING' },
        gaps: { type: 'STRING' },
        recommendation: { type: 'STRING' }
      },
      required: ['match', 'matches', 'rejected', 'overall_justification', 'gaps']
    };

    const response = await this.llm.generateStructuredOutput<MappingResult>(prompt, systemInstruction, schema);
    
    const resolvedMatches = response.matches
      .map(m => {
        const ctrl = controls[m.index - 1];
        return ctrl ? { sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: m.reason } : null;
      })
      .filter((m): m is { sysId: string; name: string; category: string; reason: string } => m !== null);

    // Build the full rejected list: use LLM-provided rejections + any controls not mentioned at all
    const mentionedIndexes = new Set([
      ...response.matches.map(m => m.index),
      ...(response.rejected || []).map(r => r.index)
    ]);
    const llmRejected = (response.rejected || []).map(r => {
      const ctrl = controls[r.index - 1];
      return ctrl ? { sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: r.reason } : null;
    }).filter(Boolean) as { sysId: string; name: string; category: string; reason: string }[];

    // Any controls not mentioned by LLM get a generic rejection note
    const unmentioned = controls
      .map((ctrl, idx) => ({ ctrl, idx: idx + 1 }))
      .filter(({ idx }) => !mentionedIndexes.has(idx))
      .map(({ ctrl }) => ({ sysId: ctrl.sysId, name: ctrl.name, category: ctrl.category || 'General', reason: 'Not evaluated as relevant to the specific risk profile and description provided.' }));

    const resolvedRejected = [...llmRejected, ...unmentioned];

    await this.adapter.writeRiskControlMapping(
      riskSysId,
      resolvedMatches,
      response.overall_justification,
      response.gaps,
      response.recommendation || ''
    );

    return {
      success: true,
      message: `Mapped ${resolvedMatches.length} control(s) to risk. Rejected ${resolvedRejected.length} control(s).`,
      details: {
        entityLabel,
        entityName: risk.profileName,
        totalControlsEvaluated: controls.length,
        matches: resolvedMatches,
        rejected: resolvedRejected,
        justification: response.overall_justification,
        gaps: response.gaps,
        recommendations: response.recommendation
      }
    };
  }
}

// ============================================================================
// Note: Schema Discovery / onboarding has moved to
// UniversalSchemaDiscoveryAgent (core/universal_schema_discovery_agent.ts),
// which adds live introspection, vector-based concept matching, and
// generates a config that DynamicAdapter can execute against directly.
// ============================================================================
