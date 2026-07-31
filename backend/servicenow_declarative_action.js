/**
 * ============================================================================
 * ServiceNow Declarative Action (UX Form Action for Next Experience Workspaces)
 * ============================================================================
 * Action Label: Map Control Using Ema
 * Action Name: map_control_using_ema
 * Table: Risk [sn_risk_risk]
 * 
 * IMPORTANT: The payload includes snUsername and snPassword so the Cloudflare
 * Worker can authenticate REST API write-back calls to your ServiceNow instance.
 * ============================================================================
 */

(function executeDeclarativeAction(inputs, outputs) {
    var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';
    
    var record = inputs.current || current;
    var riskSysId = record.getValue('sys_id');
    var riskName = record.getValue('name') || record.getValue('short_description') || 'Risk Record';

    gs.info('[Declarative Action AI Agent] Triggering Cloudflare Worker for: ' + riskName + ' (' + riskSysId + ')');

    var instanceUrl = gs.getProperty('glide.servlet.uri') || 'https://dev192667.service-now.com/';

    // Credentials for Cloudflare Worker to write controls back to YOUR ServiceNow instance
    // Can also be stored as System Properties: x_wissd_ema.admin_username / x_wissd_ema.admin_password
    var snUsername = gs.getProperty('x_wissd_ema.admin_username') || 'admin';
    var snPassword = gs.getProperty('x_wissd_ema.admin_password') || 'og%39hZNG+kR';

    var payload = {
        "platform": "servicenow",
        "agent": "risk-control-mapping",
        "targetId": riskSysId,
        "riskSysId": riskSysId,
        "instanceUrl": instanceUrl,
        "snUsername": snUsername,
        "snPassword": snPassword,
        "source": "Next Experience Workspace Declarative Action",
        "triggeredBy": gs.getUserName()
    };

    try {
        var request = new sn_ws.RESTMessageV2();
        request.setEndpoint(WORKER_URL);
        request.setHttpMethod('POST');
        request.setRequestHeader('Content-Type', 'application/json');
        request.setRequestHeader('Accept', 'application/json');
        request.setRequestHeader('X-ServiceNow-Source', 'Declarative-Form-Action');
        request.setRequestBody(JSON.stringify(payload));
        request.setHttpTimeout(30000);

        var response = request.execute();
        var httpStatus = response.getStatusCode();
        var responseBody = response.getBody();

        if (httpStatus == 200) {
            var json = JSON.parse(responseBody);

            if (json.success && json.result && json.result.success) {
                var details = json.result.details || {};
                var matches = details.matches || [];
                var message = 'AI Agent Mapped ' + matches.length + ' control(s) to Risk: ' + riskName;
                gs.addInfoMessage(message);
            } else {
                gs.addErrorMessage('AI Agent Warning: ' + (json.error || json.summary || 'Non-success payload.'));
            }
        } else {
            gs.addErrorMessage('Cloudflare Edge Call Failed: HTTP ' + httpStatus + ' - ' + responseBody);
        }
    } catch (ex) {
        gs.addErrorMessage('Declarative Action Exception: ' + ex.message);
        gs.error('[Declarative Action AI Agent Error] ' + ex.message);
    }

    if (typeof action !== 'undefined' && action.setRedirectURL) {
        action.setRedirectURL(record);
    }
})(inputs, outputs);
