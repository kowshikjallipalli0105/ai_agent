/**
 * ============================================================================
 * ServiceNow UI Action Script (Client-Side Form Button with Pop-up Modal)
 * ============================================================================
 * Table: Risk [sn_risk_risk]
 * Action name: run_ai_compliance_agent
 * Form button: Checked (true)
 * Client: Checked (true)
 * Onclick: triggerAIAgentModal()
 * Condition: current.isValidRecord()
 * 
 * Instructions:
 * 1. Replace WORKER_URL below with your deployed Cloudflare Worker URL
 * ============================================================================
 */

function triggerAIAgentModal() {
    var WORKER_URL = 'https://grc-ai-agent.your-subdomain.workers.dev/api/servicenow/trigger-agent';
    var riskSysId = g_form.getUniqueValue();
    var riskName = g_form.getValue('name') || g_form.getValue('short_description') || 'Risk Record';
    
    // Display loading message on form
    g_form.addInfoMessage('⏳ <b>AI Agent Thinking...</b> Contacting Cloudflare Edge Worker for Risk: ' + riskName);
    
    var payload = {
        platform: 'servicenow',
        agent: 'risk-control-mapping',
        targetId: riskSysId,
        riskSysId: riskSysId
    };

    var xhr = new XMLHttpRequest();
    xhr.open('POST', WORKER_URL, true);
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.setRequestHeader('Accept', 'application/json');
    
    xhr.onreadystatechange = function () {
        if (xhr.readyState === 4) {
            g_form.clearMessages();
            
            if (xhr.status === 200) {
                try {
                    var response = JSON.parse(xhr.responseText);
                    if (response.success) {
                        var summary = response.summary || 'AI Assessment complete!';
                        
                        // Show stylish alert dialog inside ServiceNow
                        g_form.addInfoMessage('✅ <b>AI Agent Success:</b> ' + summary);
                        
                        // Refresh form to show newly mapped controls
                        setTimeout(function() {
                            gsftSubmit(null, g_form.getFormElement(), 'sysverb_update_and_stay');
                        }, 1500);
                    } else {
                        g_form.addErrorMessage('❌ <b>AI Agent Error:</b> ' + (response.error || 'Failed to complete analysis.'));
                    }
                } catch (e) {
                    g_form.addErrorMessage('❌ <b>Invalid JSON Response from Cloudflare Worker:</b> ' + xhr.responseText);
                }
            } else {
                g_form.addErrorMessage('❌ <b>HTTP Error (' + xhr.status + '):</b> ' + xhr.responseText);
            }
        }
    };

    xhr.send(JSON.stringify(payload));
}
