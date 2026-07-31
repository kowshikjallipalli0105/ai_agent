/**
 * ============================================================================
 * ServiceNow Declarative Action - Map Control Using Ema
 * Action Name:  map_control_using_ema  |  Table: sn_risk_risk
 * NOTE: No function wrapper - runs flat in ServiceNow script scope.
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
            // Use JSON.parse (NOT new JSON().decode - JSON is not a constructor in Rhino)
            var result = JSON.parse(body);

            if (result && result.success && result.result && result.result.success) {
                var details = result.result.details || {};
                var matched = details.matches || [];
                gs.addInfoMessage(
                    'AI Agent mapped ' + matched.length + ' control(s) to "' + riskName +
                    '". Refresh the page to see them in the Controls related list.'
                );
            } else if (result && result.success) {
                gs.addInfoMessage('AI Agent: ' + (result.summary || 'Controls processed.'));
            } else {
                var errDetail = result ? (result.error || result.summary || body) : body;
                gs.addErrorMessage('AI Agent error: ' + errDetail);
            }
        } else {
            gs.addErrorMessage('EMA Worker HTTP Error ' + status + ': ' + body);
        }

    } catch (ex) {
        gs.addErrorMessage('EMA Exception: ' + ex.message);
        gs.error('[EMA] Exception: ' + ex.message);
    }
}
