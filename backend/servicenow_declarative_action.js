/**
 * ============================================================================
 * ServiceNow Declarative Action - Map Control Using Ema
 * ============================================================================
 * Action Name:  map_control_using_ema
 * Action Label: Map Control Using Ema
 * Table:        sn_risk_risk
 * Implemented As: Script
 * ============================================================================
 * PASTE THIS ENTIRE SCRIPT into the ServiceNow Declarative Action script field.
 * NOTE: NO function wrapper - declarative action scripts run in flat scope.
 * ============================================================================
 */

var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';

// Get the current Risk record sys_id from "current" (always available in SN scripts)
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
    gs.info('[EMA] Starting map_control_using_ema for sys_id=' + riskSysId + ' name=' + riskName);

    var instanceUrl = gs.getProperty('glide.servlet.uri') || 'https://dev192667.service-now.com/';

    var payloadObj = {
        platform:    'servicenow',
        agent:       'risk-control-mapping',
        targetId:    riskSysId,
        riskSysId:   riskSysId,
        instanceUrl: instanceUrl,
        snUsername:  'admin',
        snPassword:  'og%39hZNG+kR',
        source:      'map_control_using_ema declarative action',
        triggeredBy: gs.getUserName()
    };

    var payloadStr = JSON.stringify(payloadObj);
    gs.info('[EMA] Calling Cloudflare Worker. targetId=' + riskSysId);

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

        gs.info('[EMA] Worker HTTP ' + status + ' response: ' + body);

        if (status == 200 || status == 201) {
            var result = new JSON().decode(body);

            if (result && result.success && result.result && result.result.success) {
                var matched = (result.result.details && result.result.details.matches) ? result.result.details.matches : [];
                gs.addInfoMessage('AI Agent mapped ' + matched.length + ' control(s) to "' + riskName + '". Refresh to see them in the Controls related list.');
            } else if (result && result.success) {
                gs.addInfoMessage('AI Agent: ' + (result.summary || 'Controls processed.'));
            } else {
                var errMsg = result ? (result.error || result.summary || JSON.stringify(result)) : body;
                gs.addErrorMessage('AI Agent error: ' + errMsg);
            }
        } else {
            gs.addErrorMessage('EMA Worker HTTP Error ' + status + ': ' + body);
        }

    } catch (ex) {
        gs.addErrorMessage('EMA Agent Exception: ' + ex.message);
        gs.error('[EMA] Exception: ' + ex.message);
    }
}
