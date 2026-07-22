import axios from 'axios';
import { BaseGRCAdapter } from './base';
import { Risk, Control, TestEvidence, Factor, FactorResponse } from '../core/models';
import { GeneratedAdapterConfig, TableMapping, findTable, findAllTables, findTableForAgent } from '../core/generated_adapter_config';
import { recordSpan } from '../core/observability';

// ============================================================================
// Universal rating rubrics
//
// The two assessment agents (agents.ts) already hardcode the rating
// vocabulary they expect back from the LLM — Control Effectiveness always
// asks for Satisfactory/Needs Improvement/Weak, and inherent factors are
// asked for on a rubric the agent itself supplies per-factor. Rating SCALES
// are therefore agent-side concepts, not something discoverable from a
// target platform's schema, so DynamicAdapter applies the same universal
// rubric to every generically onboarded platform rather than trying to
// vector/LLM-discover a scale that doesn't exist as a "field" anywhere.
// ============================================================================
const CONTROL_EFFECTIVENESS_SCALE: Record<string, number> = { Satisfactory: 3, 'Needs Improvement': 2, Weak: 1 };
const INHERENT_FACTOR_SCALE: Record<string, number> = { Low: 1, Medium: 2, High: 3 };

/**
 * Generic BaseGRCAdapter implementation driven entirely by a
 * GeneratedAdapterConfig produced by UniversalSchemaDiscoveryAgent. Lets a
 * newly onboarded platform work with ControlEffectivenessAgent,
 * InherentAssessmentAgent, and RiskControlMappingAgent with zero new
 * hand-written adapter code.
 *
 * Only the 'salesforce-soql' connection type has a live query executor today
 * (matching the first live introspection connector that was built). Other
 * connection types log a clear warning and return empty results rather than
 * silently pretending to work.
 */
export class DynamicAdapter extends BaseGRCAdapter {
  private cachedToken: string | null = null;
  private tokenExpiry: number = 0;

  constructor(
    private config: GeneratedAdapterConfig,
    private instanceUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {
    super();
    this.instanceUrl = instanceUrl.replace(/\/$/, '');
    if (config.connectionType !== 'salesforce-soql') {
      console.warn(`[DynamicAdapter:${config.platformName}] connectionType '${config.connectionType}' has no query executor implemented yet; read operations will return empty results.`);
    }
  }

  getEntityLabel(): string {
    return this.config.entityLabel;
  }

  getPlatformName(): string {
    return this.config.platformName;
  }

  // --------------------------------------------------------------------------
  // Query/write plumbing (Salesforce SOQL — first supported connection type)
  // --------------------------------------------------------------------------
  private supportsLiveQueries(): boolean {
    return this.config.connectionType === 'salesforce-soql';
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedToken && now < this.tokenExpiry) return this.cachedToken;

    const params = new URLSearchParams();
    params.append('grant_type', 'client_credentials');
    params.append('client_id', this.clientId);
    params.append('client_secret', this.clientSecret);

    const response = await axios.post(`${this.instanceUrl}/services/oauth2/token`, params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    this.cachedToken = response.data.access_token;
    this.tokenExpiry = now + 55 * 60 * 1000;
    return this.cachedToken!;
  }

  private async querySOQL<T>(soql: string): Promise<T[]> {
    if (!this.supportsLiveQueries()) return [];
    const t0 = Date.now();
    try {
      const token = await this.getAccessToken();
      const response = await axios.get(`${this.instanceUrl}/services/data/v60.0/query`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { q: soql },
        timeout: 20000
      });
      const records = response.data.records as T[];
      recordSpan('platform.query', t0, 'ok', { platform: this.config.platformName, soql, rows: records.length });
      return records;
    } catch (e: any) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] SOQL query failed: ${e.message}\n  Query: ${soql}`);
      recordSpan('platform.query', t0, 'error', { platform: this.config.platformName, soql, error: e.message });
      return [];
    }
  }

  private async restUpdate(sobjectName: string, recordId: string, data: Record<string, any>): Promise<boolean> {
    if (!this.supportsLiveQueries()) return false;
    const t0 = Date.now();
    const selfHeal: string[] = [];
    // Same self-healing as restCreate: drop fields Salesforce reports as
    // non-writable for this profile and retry with the rest.
    let payload = { ...data };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const token = await this.getAccessToken();
        await axios.patch(
          `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}/${recordId}`,
          payload,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        recordSpan('platform.update', t0, 'ok', {
          platform: this.config.platformName, object: sobjectName, recordId,
          ...(selfHeal.length > 0 ? { selfHeal: selfHeal.join('; ') } : {})
        });
        return true;
      } catch (e: any) {
        const errors: any[] = Array.isArray(e.response?.data) ? e.response.data : [];
        const badFields = errors
          .filter(err => err.errorCode === 'INVALID_FIELD_FOR_INSERT_UPDATE')
          .flatMap(err => err.fields || []);
        if (badFields.length > 0 && badFields.some(f => f in payload)) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: field(s) not writable for this profile (${badFields.join(', ')}) — retrying update without them.`);
          selfHeal.push(`dropped non-writable: ${badFields.join(', ')}`);
          for (const f of badFields) delete payload[f];
          if (Object.keys(payload).length === 0) return false;
          continue;
        }
        if (this.truncateTooLongFields(payload, errors)) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: text exceeded a field's max length — retrying update with truncated value.`);
          selfHeal.push('truncated over-length text');
          continue;
        }
        const detail = e.response?.data ? ` Details: ${JSON.stringify(e.response.data)}` : '';
        console.error(`[DynamicAdapter:${this.config.platformName}] Write-back to ${sobjectName}/${recordId} failed: ${e.message}${detail}`);
        recordSpan('platform.update', t0, 'error', { platform: this.config.platformName, object: sobjectName, recordId, error: e.message });
        return false;
      }
    }
    recordSpan('platform.update', t0, 'error', { platform: this.config.platformName, object: sobjectName, recordId, error: 'retries exhausted' });
    return false;
  }

  /**
   * Handles STRING_TOO_LONG: Salesforce reports which field overflowed and
   * its max length ("max length=255"); truncate that field's value in place.
   * Returns true if anything was truncated (caller should retry).
   */
  private truncateTooLongFields(payload: Record<string, any>, errors: any[]): boolean {
    let truncated = false;
    for (const err of errors) {
      if (err.errorCode !== 'STRING_TOO_LONG') continue;
      const max = parseInt((String(err.message || '').match(/max length=(\d+)/) || [])[1] || '255', 10);
      for (const f of err.fields || []) {
        if (typeof payload[f] === 'string' && payload[f].length > max) {
          payload[f] = payload[f].substring(0, Math.max(0, max - 1)) + '…';
          truncated = true;
        }
      }
    }
    return truncated;
  }

  private async restCreate(sobjectName: string, data: Record<string, any>): Promise<string | null> {
    if (!this.supportsLiveQueries()) return null;
    const t0 = Date.now();
    const selfHeal: string[] = [];
    // Field writability varies per org/profile (formula fields, FLS): when
    // Salesforce reports specific fields as non-insertable, drop just those
    // and retry rather than failing the whole create.
    let payload = { ...data };
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const token = await this.getAccessToken();
        const response = await axios.post(
          `${this.instanceUrl}/services/data/v60.0/sobjects/${sobjectName}`,
          payload,
          { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, timeout: 15000 }
        );
        recordSpan('platform.create', t0, 'ok', {
          platform: this.config.platformName, object: sobjectName, recordId: response.data.id,
          ...(selfHeal.length > 0 ? { selfHeal: selfHeal.join('; ') } : {})
        });
        return response.data.id as string;
      } catch (e: any) {
        const errors: any[] = Array.isArray(e.response?.data) ? e.response.data : [];
        const badFields = errors
          .filter(err => err.errorCode === 'INVALID_FIELD_FOR_INSERT_UPDATE')
          .flatMap(err => err.fields || []);
        if (badFields.length > 0) {
          console.warn(`[DynamicAdapter:${this.config.platformName}] ${sobjectName}: field(s) not writable for this profile (${badFields.join(', ')}) — retrying without them.`);
          selfHeal.push(`dropped non-writable: ${badFields.join(', ')}`);
          for (const f of badFields) delete payload[f];
          continue;
        }
        const detail = e.response?.data ? ` Details: ${JSON.stringify(e.response.data)}` : '';
        console.error(`[DynamicAdapter:${this.config.platformName}] Create on ${sobjectName} failed: ${e.message}${detail}`);
        recordSpan('platform.create', t0, 'error', { platform: this.config.platformName, object: sobjectName, error: e.message });
        return null;
      }
    }
    recordSpan('platform.create', t0, 'error', { platform: this.config.platformName, object: sobjectName, error: 'retries exhausted' });
    return null;
  }

  private table(model: TableMapping['targetAgnosticModel']): TableMapping | undefined {
    return findTable(this.config, model);
  }

  /**
   * Multiple tables can map to 'Factor' — inherent rating rows (linked to an
   * assessment) vs. control answer rows (linked to a control). Selection
   * must be by required capability (which relationship the caller needs),
   * not raw confidence, or one high-confidence table shadows the other.
   */
  private factorTableWith(...requiredRels: string[]): TableMapping | undefined {
    return findAllTables(this.config, 'Factor').find(t => requiredRels.every(r => !!t.relationships[r]));
  }

  /** Maps a raw record onto a plain {agnosticField: value} dict using the table's field mappings. */
  private mapRecord(t: TableMapping, row: any): Record<string, string> {
    const out: Record<string, string> = {};
    for (const fm of t.fieldMappings) {
      const v = row[fm.sourceField];
      if (v !== undefined && v !== null) out[fm.agnosticField] = String(v);
    }
    return out;
  }

  private selectFieldList(t: TableMapping, extra: string[] = []): string {
    const fields = new Set<string>(['Id', ...t.fieldMappings.map(f => f.sourceField), ...extra]);
    return [...fields].join(', ');
  }

  // --------------------------------------------------------------------------
  // Read Operations
  // --------------------------------------------------------------------------
  async getEntityIssues(profileSysId: string): Promise<Array<{ desc: string; state: string; number?: string }>> {
    const t = this.table('Issue');
    const profileField = t?.relationships.profile;
    if (!t || !profileField) return [];

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE ${profileField} = '${profileSysId}' LIMIT 50`
    );
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return { desc: rec.desc || 'Unspecified issue', state: rec.state || 'Open', number: rec.number };
    });
  }

  /** Not part of BaseGRCAdapter — used by app.ts's generic platform-listing endpoints, duck-typed the same way ServiceNowAdapter/SalesforceAdapter expose it. */
  async getAllRisks(): Promise<Risk[]> {
    const t = this.table('Risk');
    if (!t) return [];
    const rows = await this.querySOQL<any>(`SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} ORDER BY CreatedDate DESC LIMIT 50`);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return {
        sysId: r.Id,
        name: rec.name || 'Unnamed Risk',
        description: rec.description || '',
        profileSysId: rec.profileSysId || '',
        profileName: rec.profileName || rec.name || 'Unknown entity'
      };
    });
  }

  /**
   * Not part of BaseGRCAdapter — generic assessment-instance listing for the
   * run-agent target picker. Unlike 'Factor', there's only ever one
   * legitimate AssessmentInstance table regardless of agent stage — using
   * findTableForAgent here would let a stray same-concept junk table (that
   * happens to have "Control" in its name) win over the real header table
   * for one of the two agents.
   */
  async getAllAssessmentInstances(agent?: string): Promise<{ sysId: string; riskSysId: string; riskName: string; state: string }[]> {
    // Inherent assessment starts FROM A RISK: picking one triggers creation
    // of a fresh assessment + rating rows (see getAssessmentInstance), the
    // same workflow the hand-written SalesforceAdapter implements. So the
    // target list for that agent is the risk register, not past assessments.
    if (agent === 'inherent-assessment' && this.supportsAssessmentBootstrap()) {
      const risks = await this.getAllRisks();
      return risks.map(r => ({
        sysId: r.sysId,
        riskSysId: r.sysId,
        riskName: r.name,
        state: 'Create New Assessment'
      }));
    }

    const t = this.table('AssessmentInstance');
    if (!t) return [];
    const riskField = t.relationships.risk;
    const riskNameField = this.relNameField(riskField);
    const selectFields = [...new Set(['Id', 'Name', ...(riskField ? [riskField] : []), ...(riskNameField ? [riskNameField] : [])])];
    const rows = await this.querySOQL<any>(
      `SELECT ${selectFields.join(', ')} FROM ${t.sourceTableName} ORDER BY CreatedDate DESC LIMIT 50`
    );
    return rows.map(r => {
      const riskName = riskNameField ? this.readDotted(r, riskNameField) : null;
      return {
        sysId: r.Id,
        riskSysId: riskField ? String(r[riskField] || '') : '',
        // riskName drives the dropdown label; show the risk's actual name
        // when the lookup resolves, else the record's own Name (RA-xxxxx).
        riskName: String(riskName || r.Name || 'Assessment Instance'),
        state: riskName && r.Name ? String(r.Name) : 'Open'
      };
    });
  }

  async getRisk(riskSysId: string): Promise<Risk | null> {
    const t = this.table('Risk');
    if (!t) return null;

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE Id = '${riskSysId}' LIMIT 1`
    );
    if (rows.length === 0) return null;
    const rec = this.mapRecord(t, rows[0]);

    return {
      sysId: riskSysId,
      name: rec.name || 'Unnamed Risk',
      description: rec.description || '',
      profileSysId: rec.profileSysId || '',
      profileName: rec.profileName || rec.name || 'Unknown entity'
    };
  }

  async getControlsForEntity(profileSysId: string): Promise<Control[]> {
    const t = this.table('Control');
    if (!t) return [];

    const profileField = t.relationships.profile;
    let query = `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName}`;
    if (profileField && profileSysId) query += ` WHERE ${profileField} = '${profileSysId}'`;
    query += ' LIMIT 50';

    const rows = await this.querySOQL<any>(query);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      return {
        sysId: r.Id,
        name: rec.name || 'Unnamed Control',
        description: rec.description || '',
        category: rec.category || 'General',
        profileSysId: rec.profileSysId || profileSysId,
        active: true
      };
    });
  }

  async getAssessmentInstance(instanceSysId: string): Promise<{ sysId: string; riskSysId: string } | null> {
    // More than one table can map to 'AssessmentInstance' (different
    // assessment stages) and a given sysId only exists in one of them —
    // there's no agent context at this call site to disambiguate, so try
    // each candidate until one actually contains the record.
    for (const t of findAllTables(this.config, 'AssessmentInstance')) {
      const riskField = t.relationships.risk;
      const rows = await this.querySOQL<any>(
        `SELECT Id${riskField ? ', ' + riskField : ''} FROM ${t.sourceTableName} WHERE Id = '${instanceSysId}' LIMIT 1`
      );
      if (rows.length > 0) {
        return { sysId: rows[0].Id, riskSysId: riskField ? String(rows[0][riskField] || '') : '' };
      }
    }

    // Not an existing assessment — if the ID is a risk record, trigger the
    // inherent-assessment workflow: create a fresh assessment header plus
    // its rating rows, then hand that new instance back to the agent.
    return this.bootstrapAssessmentForRisk(instanceSysId);
  }

  /**
   * The Salesforce Risk-package inherent workflow: a new assessment is
   * CREATED per run (header + Likelihood/Impact rating rows), not selected
   * from history. This create-on-demand semantic can't be discovered from
   * schema shape alone — it's carried over from the verified hand-written
   * SalesforceAdapter (gold standard), so it only activates when the
   * discovered config maps the exact Risk-package objects.
   */
  private supportsAssessmentBootstrap(): boolean {
    const header = findAllTables(this.config, 'AssessmentInstance').find(t => t.sourceTableName === 'Risk__Risk_Assessment__c');
    const rating = findAllTables(this.config, 'Factor').find(t => t.sourceTableName === 'Risk__Risk_Assessment_Rating__c');
    return !!(header && rating && this.table('Risk'));
  }

  private async bootstrapAssessmentForRisk(candidateRiskId: string): Promise<{ sysId: string; riskSysId: string } | null> {
    if (!this.supportsAssessmentBootstrap()) return null;

    const riskTable = this.table('Risk')!;
    const riskRows = await this.querySOQL<any>(`SELECT Id FROM ${riskTable.sourceTableName} WHERE Id = '${candidateRiskId}' LIMIT 1`);
    if (riskRows.length === 0) return null;

    // Duplicate-click guard: if today already produced an assessment for
    // this risk whose rating rows are still unscored, reuse it instead of
    // creating another.
    // CreatedDate (system field, always populated) rather than the custom
    // assessment-date field — the latter can be FLS-hidden for the
    // integration user, in which case Salesforce silently drops it on create
    // and a date-based filter never matches.
    const reusable = await this.querySOQL<any>(
      `SELECT Id FROM Risk__Risk_Assessment__c WHERE Risk__Risk__c = '${candidateRiskId}' AND CreatedDate = TODAY ` +
      `AND Id IN (SELECT Risk__Risk_Assessment__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Mitigation__c = 'Inherent' AND Risk__Value__c = null) ` +
      `ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (reusable.length > 0) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Reusing today's unscored assessment ${reusable[0].Id} for risk ${candidateRiskId}.`);
      return { sysId: reusable[0].Id, riskSysId: candidateRiskId };
    }

    console.log(`[DynamicAdapter:${this.config.platformName}] '${candidateRiskId}' is a risk record — creating a new Risk__Risk_Assessment__c for it...`);
    const assessmentId = await this.restCreate('Risk__Risk_Assessment__c', {
      Risk__Risk__c: candidateRiskId,
      Risk__Risk_Assessment_Date__c: new Date().toISOString().split('T')[0]
    });
    if (!assessmentId) return null;
    console.log(`[DynamicAdapter:${this.config.platformName}] Created assessment ${assessmentId}. Creating Inherent rating rows (Likelihood + Impact)...`);

    for (const category of ['Likelihood', 'Impact'] as const) {
      // Resolve the package's scoring-category reference from any existing
      // rating record of the same category (same trick as the hand-written
      // adapter — the package requires it for band calculations).
      let scoringCategoryId: string | null = null;
      try {
        const existing = await this.querySOQL<any>(
          `SELECT Risk__Scoring_Category__c FROM Risk__Risk_Assessment_Rating__c WHERE Risk__Category__c = '${category}' AND Risk__Scoring_Category__c != null LIMIT 1`
        );
        scoringCategoryId = existing[0]?.Risk__Scoring_Category__c || null;
      } catch { /* proceed without scoring category */ }

      const ratingId = await this.restCreate('Risk__Risk_Assessment_Rating__c', {
        Risk__Risk_Assessment__c: assessmentId,
        Risk__Category__c: category,
        Risk__Mitigation__c: 'Inherent',
        Risk__Is_Likelihood_Type__c: category === 'Likelihood',
        Risk__Is_Likelihood_Scoring_Category__c: category === 'Likelihood',
        ...(scoringCategoryId ? { Risk__Scoring_Category__c: scoringCategoryId } : {})
      });
      if (ratingId) {
        console.log(`[DynamicAdapter:${this.config.platformName}] Created ${category} rating row ${ratingId}.`);
      }
    }

    return { sysId: assessmentId, riskSysId: candidateRiskId };
  }

  /** Walks a possibly-dotted SOQL relationship path (e.g. "Lookup__r.Field__c") through a nested query result. */
  private readDotted(obj: any, path: string): any {
    return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
  }

  /**
   * Salesforce convention: a custom lookup field `X__c` exposes the related
   * record's name as `X__r.Name` (works at the end of dotted paths too).
   * Returns null for fields that don't follow the convention.
   */
  private relNameField(lookupField: string | undefined): string | null {
    if (!lookupField || !lookupField.endsWith('__c')) return null;
    return lookupField.replace(/__c$/, '__r.Name');
  }

  async getControlFactorRows(instanceSysId: string): Promise<FactorResponse[]> {
    // Control-effectiveness answer rows: needs a Factor table that links to
    // BOTH a control and (directly or via a dotted junction path) the
    // assessment/risk context.
    const t = this.factorTableWith('control', 'assessment');
    const assessmentField = t?.relationships.assessment;
    const controlField = t?.relationships.control;
    if (!t || !assessmentField || !controlField) return [];

    // A dotted relationship path (e.g. a junction object's lookup field)
    // means this table links to the assessment indirectly through the risk,
    // not by the assessment's own Id — resolve the risk first.
    let filterValue = instanceSysId;
    if (assessmentField.includes('.')) {
      const inst = await this.getAssessmentInstance(instanceSysId);
      if (!inst || !inst.riskSysId) return [];
      filterValue = inst.riskSysId;
    }

    const controlNameField = this.relNameField(controlField);
    const selectFields = [...new Set(['Id', ...t.fieldMappings.map(f => f.sourceField), controlField, ...(controlNameField ? [controlNameField] : [])])];
    const rows = await this.querySOQL<any>(
      `SELECT ${selectFields.join(', ')} FROM ${t.sourceTableName} WHERE ${assessmentField} = '${filterValue}' AND ${controlField} != null LIMIT 100`
    );
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      const controlSysId = controlField.includes('.') ? this.readDotted(r, controlField) : r[controlField];
      const controlName = controlNameField ? this.readDotted(r, controlNameField) : null;
      return {
        sysId: r.Id,
        factorSysId: r.Id,
        factorName: rec.factorName || 'Control Effectiveness Factor',
        controlSysId: String(controlSysId || ''),
        controlName: String(controlName || rec.controlName || '')
      };
    });
  }

  async getAnswerableManualRows(instanceSysId: string): Promise<Factor[]> {
    // Inherent rating rows: needs a Factor table linked to the assessment
    // but NOT organized around a control.
    const t = findAllTables(this.config, 'Factor').find(x => x.relationships.assessment && !x.relationships.control)
      || this.factorTableWith('assessment');
    const assessmentField = t?.relationships.assessment;
    if (!t || !assessmentField) return [];
    const controlField = t.relationships.control;

    let query = `SELECT ${this.selectFieldList(t, controlField ? [controlField] : [])} FROM ${t.sourceTableName} WHERE ${assessmentField} = '${instanceSysId}'`;
    if (controlField) query += ` AND ${controlField} = null`;
    query += ' LIMIT 50';

    const rows = await this.querySOQL<any>(query);
    return rows.map(r => {
      const rec = this.mapRecord(t, r);
      const name = rec.factorName || 'Inherent Factor';
      return {
        sysId: r.Id,
        factorSysId: r.Id,
        factorName: name,
        factorDesc: rec.factorDesc || `Inherent ${name} rating — assess before controls.`,
        guidance: rec.guidance || 'Rate Low, Medium, or High based on standard rubric guidance for this factor.',
        choiceList: Object.keys(INHERENT_FACTOR_SCALE),
        choiceMap: INHERENT_FACTOR_SCALE
      };
    });
  }

  async getFactorChoices(factorSysId: string): Promise<Factor | null> {
    // factorSysId here is the row sysId produced by getControlFactorRows —
    // generically onboarded platforms use the universal control-effectiveness
    // rubric (see module comment above) rather than a discovered scale.
    return {
      sysId: factorSysId,
      factorSysId,
      factorName: 'Control Effectiveness Factor',
      factorDesc: 'Universal control effectiveness rubric applied to generically onboarded platforms.',
      guidance: 'Select Satisfactory for zero open issues and passing tests, Needs Improvement for minor open issues, Weak for failing tests or missing evidence.',
      choiceList: Object.keys(CONTROL_EFFECTIVENESS_SCALE),
      choiceMap: CONTROL_EFFECTIVENESS_SCALE
    };
  }

  async getControlEvidence(controlSysId: string): Promise<TestEvidence> {
    const empty: TestEvidence = {
      sysId: controlSysId,
      number: controlSysId,
      name: '',
      state: 'Unknown',
      effectiveness: 'Not Tested',
      status: 'Unknown',
      latestResult: 'No test evidence table mapped for this platform.',
      resultDate: '',
      openIssues: [],
      closedIssues: 0
    };

    const t = this.table('TestEvidence');
    const controlField = t?.relationships.control;
    if (!t || !controlField) return empty;

    const rows = await this.querySOQL<any>(
      `SELECT ${this.selectFieldList(t)} FROM ${t.sourceTableName} WHERE ${controlField} = '${controlSysId}' ORDER BY CreatedDate DESC LIMIT 1`
    );
    if (rows.length === 0) return empty;
    const rec = this.mapRecord(t, rows[0]);

    return {
      sysId: controlSysId,
      number: rows[0].Id || controlSysId,
      name: rec.name || '',
      state: rec.state || 'Active',
      effectiveness: rec.effectiveness || 'Not Tested',
      status: rec.status || 'Unknown',
      latestResult: rec.latestResult || 'No test result notes on record.',
      resultDate: rec.resultDate || '',
      openIssues: [],
      closedIssues: 0
    };
  }

  // --------------------------------------------------------------------------
  // Prior Assessment Retrieval — not generically discoverable (requires
  // knowing which state value means "closed", which varies per org/schema).
  // --------------------------------------------------------------------------
  async getPriorClosedAssessment(): Promise<{ sysId: string; number: string } | null> {
    return null;
  }

  async getPriorControlAnswer() {
    return null;
  }

  // --------------------------------------------------------------------------
  // Write Operations — use writeHeuristics guessed during discovery. Any
  // missing guess is logged and skipped rather than silently failing.
  // --------------------------------------------------------------------------
  async writeControlEffectiveness(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    evidenceSummary: string,
    _auditTrail: string,
    fingerprint: string
  ): Promise<void> {
    // Write back to the same table getControlFactorRows read from.
    const t = this.factorTableWith('control', 'assessment');
    const wh = t?.writeHeuristics;
    if (!t || !wh || (!wh.scoreField && !wh.justificationField)) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] No write-back fields detected for Factor table; skipping write for row ${rowSysId} (would have written rating '${ratingLabel}').`);
      return;
    }
    const data: Record<string, any> = {};
    if (wh.scoreField) data[wh.scoreField] = score;
    if (wh.justificationField) data[wh.justificationField] = `[AI] ${justification}\n\nEvidence: ${evidenceSummary}`;
    if (wh.fingerprintField) data[wh.fingerprintField] = fingerprint;

    const ok = await this.restUpdate(t.sourceTableName, rowSysId, data);
    if (ok) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Updated ${t.sourceTableName} ${rowSysId} -> ${ratingLabel}`);
    }
  }

  async writeInherentFactor(
    rowSysId: string,
    score: number,
    ratingLabel: string,
    justification: string,
    comment: string
  ): Promise<void> {
    // Write back to the same table getAnswerableManualRows read from.
    const t = findAllTables(this.config, 'Factor').find(x => x.relationships.assessment && !x.relationships.control)
      || this.factorTableWith('assessment');
    const wh = t?.writeHeuristics;
    if (!t || !wh || (!wh.scoreField && !wh.justificationField)) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] No write-back fields detected for Factor table; skipping write for row ${rowSysId} (would have written rating '${ratingLabel}').`);
      return;
    }
    const data: Record<string, any> = {};
    if (wh.scoreField) data[wh.scoreField] = score;
    if (wh.justificationField) data[wh.justificationField] = comment;

    const ok = await this.restUpdate(t.sourceTableName, rowSysId, data);
    if (ok) {
      console.log(`[DynamicAdapter:${this.config.platformName}] Updated ${t.sourceTableName} ${rowSysId} -> ${ratingLabel}`);
    }
  }

  async writeRiskControlMapping(
    riskSysId: string,
    matchedControls: Array<{ sysId: string; reason: string }>
  ): Promise<void> {
    // A risk-control junction/lookup table has no read-side agnostic model in
    // the concept catalog (it's a relationship, not a record type), so it
    // can't be vector/LLM-discovered the way Risk/Control/Factor tables are.
    // Onboarding write-back for this relationship requires the platform's
    // junction object name to be supplied explicitly.
    console.warn(`[DynamicAdapter:${this.config.platformName}] Risk-control mapping write-back is not schema-mapped for this platform; ${matchedControls.length} match(es) for risk ${riskSysId} were computed but NOT persisted. Provide the junction object name to enable this.`);
  }

  async writeFailure(rowSysId: string, reason: string): Promise<void> {
    const t = this.table('Factor');
    const justificationField = t?.writeHeuristics?.justificationField;
    if (!t || !justificationField) {
      console.warn(`[DynamicAdapter:${this.config.platformName}] Row ${rowSysId} failed: ${reason} (no justification field to record it against)`);
      return;
    }
    await this.restUpdate(t.sourceTableName, rowSysId, { [justificationField]: `❌ WissdaSense assessment failed: ${reason}` });
  }
}
