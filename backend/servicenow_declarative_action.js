/**
 * ============================================================================
 * ServiceNow Declarative Action - Map Control Using Ema
 * Action Name:  map_control_using_ema  |  Table: sn_risk_risk
 * NOTE: Populates sn_risk_m2m_risk_control + updates sn_compliance_control
 * state to monitor/compliant so Controls related list displays records.
 * ============================================================================
 */

var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';

var riskSysId = '';
var riskName  = '';

try {
    riskSysId = current.getValue('sys_id') || current.sys_id.toString();
    riskName  = current.getValue('name') || current.getValue('short_description') || 'Risk';
} catch (e) {
    gs.error('[EMA] Could not read record: ' + e.message);
}

if (!riskSysId) {
    gs.addErrorMessage('EMA Agent: Could not determine Risk sys_id. Please refresh and try again.');
}

if (riskSysId) {
    gs.info('[EMA] Starting for sys_id=' + riskSysId + ' name=' + riskName);

    var instanceUrl = gs.getProperty('glide.servlet.uri') || 'https://dev192667.service-now.com/';

    var payloadStr = JSON.stringify({
        platform:    'servicenow',
        agent:       'risk-control-mapping',
        targetId:    riskSysId,
        riskSysId:   riskSysId,
        instanceUrl: instanceUrl,
        snUsername:  'admin',
        snPassword:  'og%39hZNG+kR',
        source:      'map_control_using_ema declarative action',
        triggeredBy: gs.getUserName()
    });

    try {
        var rm = new sn_ws.RESTMessageV2();
        rm.setEndpoint(WORKER_URL);
        rm.setHttpMethod('POST');
        rm.setRequestHeader('Content-Type', 'application/json');
        rm.setRequestHeader('Accept', 'application/json');
        rm.setRequestBody(payloadStr);
        rm.setHttpTimeout(55000);

        var resp   = rm.execute();
        var status = resp.getStatusCode();
        var body   = resp.getBody();

        gs.info('[EMA] Worker HTTP ' + status + ': ' + body);

        if (status == 200 || status == 201) {
            var result = JSON.parse(body);

            if (result && result.success && result.result && result.result.success) {
                var details = result.result.details || {};
                var matched = details.matches || [];
                var createdCount = 0;

                // Native GlideRecord Write-Back directly into ServiceNow tables!
                for (var i = 0; i < matched.length; i++) {
                    var ctrlSysId = matched[i].sysId;
                    if (!ctrlSysId) continue;

                    // 1. Insert into sn_risk_m2m_risk_control (Risk Workspace Controls tab table)
                    try {
                        var grM2m = new GlideRecord('sn_risk_m2m_risk_control');
                        grM2m.addQuery('risk', riskSysId);
                        grM2m.addQuery('control', ctrlSysId);
                        grM2m.query();
                        if (!grM2m.hasNext()) {
                            grM2m.initialize();
                            grM2m.setValue('risk', riskSysId);
                            grM2m.setValue('control', ctrlSysId);
                            grM2m.setValue('sn_risk', riskSysId);
                            grM2m.setValue('sn_control', ctrlSysId);
                            grM2m.setValue('risk_status', 'mitigated');
                            grM2m.insert();
                            createdCount++;
                        }
                    } catch (eM2m) {
                        gs.error('[EMA] m2m insert error: ' + eM2m.message);
                    }

                    // 2. Update sn_compliance_control state to monitor / compliant & risk reference
                    try {
                        var grCtrl = new GlideRecord('sn_compliance_control');
                        if (grCtrl.get(ctrlSysId)) {
                            grCtrl.setValue('risk', riskSysId);
                            grCtrl.setValue('applicable_to', riskSysId);
                            grCtrl.setValue('state', 'monitor');
                            grCtrl.setValue('status', 'compliant');
                            grCtrl.update();
                        }
                    } catch (eCtrl) {
                        gs.error('[EMA] control update error: ' + eCtrl.message);
                    }
                }

                gs.addInfoMessage(
                    '🤖 AI Agent mapped ' + matched.length + ' control(s) to "' + riskName + '". Link created in Controls related list.'
                );
            } else if (result && result.success) {
                gs.addInfoMessage('AI Agent: ' + (result.summary || 'Controls processed.'));
            } else {
                gs.addErrorMessage('AI Agent error: ' + (result ? (result.error || result.summary || body) : body));
            }
        } else {
            gs.addErrorMessage('EMA Worker HTTP Error ' + status + ': ' + body);
        }

    } catch (ex) {
        gs.addErrorMessage('EMA Exception: ' + ex.message);
        gs.error('[EMA] Exception: ' + ex.message);
    }

    if (typeof action !== 'undefined' && action.setRedirectURL) {
        action.setRedirectURL(current);
    }
}
