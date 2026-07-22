/**
 * ============================================================================
 * ServiceNow UI Action Script (Server-Side Form Button)
 * ============================================================================
 * Table: Risk [sn_risk_risk] (or Assessment Instance [sn_risk_advanced_risk_assessment_instance])
 * Action name: assess_risk_with_ai
 * Form button: Checked (true)
 * Client: Unchecked (false)
 * Onclick: (leave blank)
 * Condition: current.isValidRecord()
 * 
 * Instructions:
 * 1. Replace WORKER_URL below with your deployed Cloudflare Worker URL
 *    (e.g., https://grc-ai-agent.your-subdomain.workers.dev/api/servicenow/trigger-agent)
 * ============================================================================
 */

(function executeUIAction(current, previous) {
    // 1. Configure Cloudflare Worker Endpoint
    var WORKER_URL = 'https://grc-ai-agent.your-subdomain.workers.dev/api/servicenow/trigger-agent';
    
    // 2. Prepare payload from current ServiceNow GlideRecord
    var riskSysId = current.getValue('sys_id');
    var riskName = current.getValue('name') || current.getValue('short_description') || 'Unnamed Risk';
    
    var payload = {
        "platform": "servicenow",
        "agent": "risk-control-mapping", // Options: 'risk-control-mapping', 'control-effectiveness', 'inherent-assessment'
        "targetId": riskSysId,
        "riskSysId": riskSysId,
        "triggeredBy": gs.getUserName()
    };
    
    gs.info('[AI Agent Trigger] Initiating request to Cloudflare Worker for Risk: ' + riskName + ' (' + riskSysId + ')');
    
    try {
        // 3. Construct HTTP REST Call using ServiceNow RESTMessageV2
        var request = new sn_ws.RESTMessageV2();
        request.setEndpoint(WORKER_URL);
        request.setHttpMethod('POST');
        request.setRequestHeader('Content-Type', 'application/json');
        request.setRequestHeader('Accept', 'application/json');
        request.setRequestHeader('X-ServiceNow-Source', 'ServiceNow-UI-Action');
        request.setRequestBody(JSON.stringify(payload));
        
        // 4. Set timeout (30 seconds)
        request.setHttpTimeout(30000);
        
        // 5. Execute Request
        var response = request.execute();
        var httpStatus = response.getStatusCode();
        var responseBody = response.getBody();
        
        gs.info('[AI Agent Trigger] Response status: ' + httpStatus);
        
        if (httpStatus == 200) {
            var json = JSON.parse(responseBody);
            
            if (json.success) {
                var message = '🤖 <b>AI Agent Execution Complete!</b><br/>';
                if (json.summary) {
                    message += json.summary;
                } else if (json.result && json.result.overall_justification) {
                    message += json.result.overall_justification;
                } else {
                    message += 'Mapped controls updated successfully.';
                }
                
                // Show green info message in ServiceNow UI
                gs.addInfoMessage(message);
            } else {
                gs.addErrorMessage('⚠️ <b>AI Agent Execution Warning:</b> ' + (json.error || 'Unknown error returned from agent.'));
            }
        } else {
            gs.addErrorMessage('❌ <b>AI Agent Call Failed:</b> HTTP ' + httpStatus + ' - ' + responseBody);
        }
        
    } catch (ex) {
        gs.addErrorMessage('❌ <b>Exception Triggering AI Agent:</b> ' + ex.message);
        gs.error('[AI Agent Trigger Exception] ' + ex.message);
    }
    
    // 6. Refresh current form page so updated controls & assessment fields are displayed
    action.setRedirectURL(current);
    
})(current, previous);
