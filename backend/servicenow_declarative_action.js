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
 * ============================================================================
 */

(function executeDeclarativeAction(inputs, outputs) {

    // ---- 1. Config ----
    var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';

    // ---- 2. Get the current Risk record ----
    // In Next Experience Declarative Actions, "current" is available directly
    var riskSysId = '';
    var riskName = '';

    try {
        if (current && current.sys_id) {
            riskSysId = current.getValue('sys_id') || current.sys_id.toString();
            riskName  = current.getValue('name') || current.getValue('short_description') || 'Risk';
        } else if (inputs && inputs.current) {
            riskSysId = inputs.current.getValue('sys_id');
            riskName  = inputs.current.getValue('name') || 'Risk';
        }
    } catch(e) {
        gs.error('[EMA] Could not read record: ' + e.message);
    }

    if (!riskSysId) {
        gs.addErrorMessage('EMA Agent: Could not read the Risk record sys_id. Please refresh and try again.');
        return;
    }

    gs.info('[EMA] Starting map_control_using_ema for sys_id=' + riskSysId + ' name=' + riskName);

    // ---- 3. Build payload ----
    var instanceUrl = gs.getProperty('glide.servlet.uri');
    if (!instanceUrl) instanceUrl = 'https://dev192667.service-now.com/';

    var payload = JSON.stringify({
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

    gs.info('[EMA] Calling worker: ' + WORKER_URL + ' with payload targetId=' + riskSysId);

    // ---- 4. Call Cloudflare Worker ----
    try {
        var rm = new sn_ws.RESTMessageV2();
        rm.setEndpoint(WORKER_URL);
        rm.setHttpMethod('POST');
        rm.setRequestHeader('Content-Type', 'application/json');
        rm.setRequestHeader('Accept', 'application/json');
        rm.setRequestBody(payload);
        rm.setHttpTimeout(55000); // 55 second timeout (Cloudflare Worker has 30s AI budget)

        var resp   = rm.execute();
        var status = resp.getStatusCode();
        var body   = resp.getBody();

        gs.info('[EMA] Worker response HTTP ' + status + ': ' + body);

        if (status == 200 || status == 201) {
            var json = new JSON().decode(body);

            if (json && json.success && json.result && json.result.success) {
                var details = json.result.details || {};
                var matched = details.matches || [];
                gs.addInfoMessage(
                    'AI Agent mapped ' + matched.length + ' control(s) to "' + riskName +
                    '". Refresh the page to see them in the Controls related list.'
                );
            } else if (json && json.success) {
                gs.addInfoMessage('AI Agent: ' + (json.summary || 'Controls processed.'));
            } else {
                gs.addErrorMessage(
                    'AI Agent returned an error: ' +
                    (json ? (json.error || json.summary || JSON.stringify(json)) : body)
                );
            }
        } else {
            gs.addErrorMessage('EMA Worker HTTP Error ' + status + ': ' + body);
        }

    } catch(ex) {
        gs.addErrorMessage('EMA Agent Exception: ' + ex.message);
        gs.error('[EMA] Exception calling Cloudflare Worker: ' + ex.message);
    }

})(inputs, outputs);
