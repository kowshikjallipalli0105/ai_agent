/**
 * ============================================================================
 * ServiceNow Declarative Action (UX Form Action for Next Experience Workspaces)
 * ============================================================================
 * Location: Declarative Actions -> Form Actions (sys_declarative_action_assignment)
 * Table: Risk [sn_risk_risk] (or Assessment Instance [sn_risk_advanced_risk_assessment_instance])
 * Action Label: Assess Risk with AI Agent
 * Action Name: assess_risk_with_ai_declarative
 * Implemented As: Script (or UX Action Payload / Server Script)
 * Form Location: Form Header
 * 
 * Cloudflare Worker Live Endpoint:
 * https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent
 * ============================================================================
 */

(function executeDeclarativeAction(inputs, outputs) {
    // 1. Live Cloudflare Edge Worker URL
    var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';
    
    // 2. Extract current record sys_id from Workspace Action inputs
    var record = inputs.current || current;
    var riskSysId = record.getValue('sys_id');
    var riskName = record.getValue('name') || record.getValue('short_description') || 'Risk Record';

    gs.info('[Declarative Action AI Agent] Triggering Cloudflare Worker for: ' + riskName + ' (' + riskSysId + ')');

    // 3. Build AI Agent Payload
    var payload = {
        "platform": "servicenow",
        "agent": "risk-control-mapping",
        "targetId": riskSysId,
        "riskSysId": riskSysId,
        "source": "Next Experience Workspace Declarative Action",
        "triggeredBy": gs.getUserName()
    };

    try {
        // 4. Send REST Request to Cloudflare Worker
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

            if (json.success) {
                var message = '🤖 <b>AI Agent Completed (Declarative Action):</b><br/>';
                message += (json.summary || 'Mitigating risk controls analyzed and mapped successfully.');
                gs.addInfoMessage(message);
            } else {
                gs.addErrorMessage('⚠️ <b>AI Agent Warning:</b> ' + (json.error || 'Execution returned non-success payload.'));
            }
        } else {
            gs.addErrorMessage('❌ <b>Cloudflare Edge Call Failed:</b> HTTP ' + httpStatus + ' - ' + responseBody);
        }
    } catch (ex) {
        gs.addErrorMessage('❌ <b>Declarative Action Exception:</b> ' + ex.message);
        gs.error('[Declarative Action AI Agent Error] ' + ex.message);
    }
})(inputs, outputs);
