# ServiceNow Button Integration & Cloudflare Hosting Guide

This document provides step-by-step instructions to:
1. **Deploy your GRC AI Agent Backend to Cloudflare Workers**
2. **Create a Button in ServiceNow** to trigger the AI Agent on any record click.

---

## Part 1: Deploying the AI Agent to Cloudflare Workers

### Prerequisites
- [Node.js](https://nodejs.org/) (v18+) installed.
- A free [Cloudflare Account](https://dash.cloudflare.com/).

### Step 1: Install Wrangler & Log in to Cloudflare
In your terminal, navigate to the backend directory:
```bash
cd "d:\ai_agent\backend"
```

Run Wrangler login to authenticate your machine with Cloudflare:
```bash
npx wrangler login
```
*(A browser window will open asking you to authorize Cloudflare CLI).*

### Step 2: Set Environment Variables / Secrets in Cloudflare
Set your Gemini API Key and ServiceNow PDI credentials as Cloudflare secrets:

```bash
npx wrangler secret put GEMINI_API_KEY
# Enter your Gemini API Key when prompted

npx wrangler secret put SERVICENOW_INSTANCE_URL
# Example: https://devXXXXX.service-now.com

npx wrangler secret put SERVICENOW_USERNAME
# Example: admin

npx wrangler secret put SERVICENOW_PASSWORD
# Enter your ServiceNow PDI admin password

npx wrangler secret put SERVICENOW_USE_LIVE
# Enter: true
```

### Step 3: Deploy to Cloudflare Edge
Run the deployment script:
```bash
npm run deploy
```

Wrangler will compile the TypeScript worker and deploy it globally.
Upon completion, Wrangler will display your live Cloudflare Worker URL, for example:
`https://grc-ai-agent.your-subdomain.workers.dev`

---

## Part 2: Creating the Button inside ServiceNow Platform

You can create the button on any ServiceNow table (e.g. `sn_risk_risk` Risk form, or `sn_compliance_control` Control form).

### Step-by-Step Instructions:

1. Log into your **ServiceNow Instance** as System Administrator.
2. In the Filter Navigator on the left, search for **`UI Actions`** (under *System Definition* -> *UI Actions*).
3. Click **New** to create a new UI Action.
4. Fill in the Form Details:
   - **Name**: `Assess Risk with AI Agent`
   - **Table**: `Risk [sn_risk_risk]` (or select your target GRC table)
   - **Action name**: `assess_risk_with_ai`
   - **Form button**: Check `true` (✅)
   - **Client**: Uncheck `false` (or check `true` if using client script)
   - **Active**: Check `true` (✅)
   - **Comments**: `Triggers the Cloudflare Edge Worker AI Agent to map mitigating controls.`

5. **Copy & Paste the Script**:
   Open [servicenow_ui_action_server.js](file:///d:/ai_agent/backend/servicenow_ui_action_server.js) and paste its content into the **Script** text area:

   ```javascript
   (function executeUIAction(current, previous) {
       // REPLACE WITH YOUR LIVE CLOUDFLARE WORKER URL
       var WORKER_URL = 'https://grc-ai-agent.your-subdomain.workers.dev/api/servicenow/trigger-agent';
       
       var riskSysId = current.getValue('sys_id');
       var payload = {
           "platform": "servicenow",
           "agent": "risk-control-mapping",
           "targetId": riskSysId,
           "riskSysId": riskSysId
       };
       
       try {
           var request = new sn_ws.RESTMessageV2();
           request.setEndpoint(WORKER_URL);
           request.setHttpMethod('POST');
           request.setRequestHeader('Content-Type', 'application/json');
           request.setRequestHeader('Accept', 'application/json');
           request.setRequestBody(JSON.stringify(payload));
           request.setHttpTimeout(30000);
           
           var response = request.execute();
           var httpStatus = response.getStatusCode();
           var responseBody = response.getBody();
           
           if (httpStatus == 200) {
               var json = JSON.parse(responseBody);
               if (json.success) {
                   gs.addInfoMessage('🤖 <b>AI Agent Completed!</b> ' + (json.summary || 'Controls mapped successfully.'));
               } else {
                   gs.addErrorMessage('⚠️ AI Agent Error: ' + json.error);
               }
           } else {
               gs.addErrorMessage('❌ HTTP Error ' + httpStatus + ': ' + responseBody);
           }
       } catch (ex) {
           gs.addErrorMessage('❌ Exception: ' + ex.message);
       }
       
       action.setRedirectURL(current);
   })(current, previous);
   ```

6. Click **Submit** or **Update**.

---

## Part 2B: Declarative Actions (Next Experience & Configurable Workspaces)

If you are using ServiceNow **Next Experience Workspaces** (e.g., *GRC Workspace*, *Risk Operations Workspace*, or *Configurable Workspaces*), you can implement this as a **Declarative Action** (`sys_declarative_action_assignment`):

### Quick Setup Steps:
1. In the Filter Navigator, search for **`Declarative Actions`** -> **`Form Actions`** (`sys_declarative_action_assignment`).
2. Click **New**.
3. Set the Action Properties:
   - **Action Label**: `Assess Risk with AI Agent`
   - **Action Name**: `assess_risk_with_ai_declarative`
   - **Model / Table**: `Risk [sn_risk_risk]` (or `Assessment Instance`)
   - **Implemented As**: Select **`Script`** (or **`Server Script`**)
   - **Form Location**: **`Form Header`**
   - **Workspace**: Select your target Workspace (e.g., `GRC Workspace` or `Global`).
4. Paste the script from [servicenow_declarative_action.js](file:///d:/ai_agent/backend/servicenow_declarative_action.js):

   ```javascript
   (function executeDeclarativeAction(inputs, outputs) {
       var WORKER_URL = 'https://aiagent.kowshik0105.workers.dev/api/servicenow/trigger-agent';
       var record = inputs.current || current;
       var riskSysId = record.getValue('sys_id');
       
       var payload = {
           "platform": "servicenow",
           "agent": "risk-control-mapping",
           "targetId": riskSysId,
           "triggeredBy": gs.getUserName()
       };

       var request = new sn_ws.RESTMessageV2();
       request.setEndpoint(WORKER_URL);
       request.setHttpMethod('POST');
       request.setRequestHeader('Content-Type', 'application/json');
       request.setRequestBody(JSON.stringify(payload));
       request.setHttpTimeout(30000);

       var response = request.execute();
       if (response.getStatusCode() == 200) {
           var json = JSON.parse(response.getBody());
           gs.addInfoMessage('🤖 AI Agent Executed: ' + (json.summary || 'Controls mapped successfully.'));
       } else {
           gs.addErrorMessage('❌ Cloudflare Edge Call Failed: HTTP ' + response.getStatusCode());
       }
   })(inputs, outputs);
   ```

5. Click **Submit**.

> 💡 **Pro-Tip (Classic UI Action in Workspaces)**: Alternatively, if you already created the classic UI Action from Part 2A, open your UI Action record and check the **`Format for Workspace`** or **`Form Header`** box under the *Workspace* tab to automatically register it as a Declarative Action in Next Experience Workspaces.

---

## Part 3: How It Works & Testing

1. Open any record in ServiceNow under **Risk** -> **All Risks** (e.g. `Unauthorized DB Access`).
2. At the top header of the form (in Classic UI or Workspace), you will see your button: **`[🤖 Assess Risk with AI Agent]`**.
3. Click the button.
4. ServiceNow will send an encrypted HTTPS POST call to your **Cloudflare Edge Worker** (`https://aiagent.kowshik0105.workers.dev`).
5. The Cloudflare Worker will execute the **GRC Reasoning Agent**, calling Gemini LLM for analysis, querying ServiceNow data, and writing back the mapped mitigating controls to `sn_risk_m2m_risk_control`.
6. ServiceNow will display a success banner: **"🤖 AI Agent Completed! Mitigating controls mapped successfully."** and refresh the page with updated relations!
