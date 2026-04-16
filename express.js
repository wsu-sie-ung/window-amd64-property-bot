const express = require('express');
const app = express();

app.use(express.json());

const { runBot: runIprop } = require('./iprop')
const { runBot: runPropGuru } = require('./propguru')

// Map of platform names to their respective bot functions
const botMap = {
  'iproperty': runIprop,
  'propertyguru': runPropGuru
};

//healthcheck endpoint
app.get('/api/v1/status', (req, res) => { //this is a GET request
  res.json({ //response with a json object
    status: 'Running',
    timestamp: new Date().toISOString()
  });
});

//choose bot based on platform
app.post('/api/v1/job', async (req, res) => {
  // values that client provides (request body)
  const body = req.body || {};

  const jobId = body.jobId;                   
  const agentId = body.agentId;               
  const agentEmail = body.email;
  const agentPassword = body.password;
  const unitInfo = body.unitInfo || {};       
  const platform = body.platform;             // required: "iproperty" | "propertyguru"
  const browserProfilePath = body.browserProfilePath || '';
  const ip = body.ip || '';
  const post_to_propertyguru = body.post_to_propertyguru;
  const post_to_iproperty = body.post_to_iproperty;
  const timeout = body.timeout || 60000;      // max execution time (ms)

  //API debugging 
  const missingFields = []
  if (!jobId) missingFields.push("jobId")
  if (!platform) missingFields.push("platform")
  if (!agentId) missingFields.push("agentId")

  if (missingFields.length) {
    return res.status(400).json({ error: `Missing required fields: ${missingFields.join(", ")}` })
  }

  if (typeof agentId !== 'string') {
    return res.status(400).json({
      error: 'agentId must be a string'
    });
  } 

  const runBot = botMap[platform]
  if (!runBot) {
    return res.status(400).json({
      error: 'Invalid platform. Use iproperty or propertyguru'
    })
  }

  try {
    const result = await runBot({
      platform,
      agentId,
      jobId,
      unitInfo,
      browserProfilePath,
      ip,
      timeout,
      email: agentEmail,
      password: agentPassword, 
      post_to_propertyguru,
      post_to_iproperty
    })

    // If result is undefined, it means the bot failed and swallowed the error
    if (!result) throw new Error("Bot execution returned no result");

    const isCaptcha = result.captchaDetected === true
    const isSuccess = result.success === true

    // Determine descriptive status
    let status = 'failed'
    if (isSuccess) status = 'success'

    res.json({
      jobId,
      status,
      captchaDetected: isCaptcha,
      error: isSuccess ? null : (result.error || 'Unknown failure')
    })
  } catch (err) {
    res.status(500).json({
      jobId,
      status: 'failed',
      captchaDetected: false,
      error: err.message || String(err)
    })
  }
});

// const PORT = process.env.PORT || 3002;
const PORT = process.env.PORT || 3000;
// app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
