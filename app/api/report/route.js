// app/api/report/route.js
export async function POST(req) {
  try {
    const jiraSite = process.env.JIRA_SITE;
    const jiraEmail = process.env.JIRA_EMAIL;
    const jiraToken = process.env.JIRA_API_TOKEN;
    const jiraProjectKey = process.env.JIRA_PROJECT_KEY;

    const formData = await req.formData();

    // Convert all form data to a plain object for easy inspection:
    const allData = {};
    for (const [key, value] of formData.entries()) {
      if (typeof value === 'string') {
        allData[key] = value;
      } else if (typeof value?.text === 'function') {
        allData[key] = await value.text();
      } else {
        allData[key] = value;
      }
    }
    console.log('All form data from webhook:', allData);

    // Grab formTitle (works for 'formTitle' or 'FormTitle')
    const formTitle = formData.get('formTitle') ?? formData.get('FormTitle');

    // Grab pretty field
    const prettyField = formData.get('pretty') ?? formData.get('Pretty');

    let prettyArray = [];

    if (prettyField != null) {
      // If the field is a File-like object, read its text; otherwise use string form
      let raw;
      if (typeof prettyField === 'string') {
        raw = prettyField;
      } else if (typeof prettyField?.text === 'function') {
        raw = await prettyField.text();
      } else {
        raw = String(prettyField);
      }

      // Clean up and remove accidental leading label
      raw = raw.trim().replace(/^\s*pretty[:\s-]*/i, '');

      // Split into segments by comma and parse key:value
      const segments = raw.split(/\s*,\s*/);
      for (const seg of segments) {
        if (!seg) continue;
        const idx = seg.indexOf(':');
        if (idx === -1) {
          prettyArray.push({ key: seg.trim(), value: '' });
        } else {
          const key = seg.slice(0, idx).trim();
          const value = seg.slice(idx + 1).trim();
          prettyArray.push({ key, value });
        }
      }
    }

    // 🔹 Scan all form data values for URLs containing https://
    const urlRegex = /https:\\?\/\\?\/[^\s"']+/gi; // matches https://... or https:\/\...
    let urlMatches = [];

    for (const [key, val] of Object.entries(allData)) {
      if (typeof val === 'string') {
        const matches = val.match(urlRegex);
        if (matches) {
          urlMatches.push(...matches);
        }
      }
    }

    if (urlMatches.length > 0) {
      urlMatches.forEach((u, idx) => {
        prettyArray.push({ key: `URL ${idx + 1}`, value: u });
      });
    }

    // Build the combined object
    const result = {
      formTitle: formTitle ?? '',
      pretty: prettyArray,
    };

    console.log('Parsed form data:', result);

    // 🔹 send to Slack
    const webhookUrl = process.env.SLACK_WEBHOOK_URL; // store your URL in an env var
    if (webhookUrl) {
      // Format a readable message for Slack
      const textLines = [
        `*${result.formTitle}*`,
        ...result.pretty.map(p => `• *${p.key}*: ${p.value}`),
      ];
      const slackMessage = { text: textLines.join('\n') };

      const slackRes = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackMessage),
      });

      if (!slackRes.ok) {
        console.error('Slack webhook failed:', await slackRes.text());
      }
    } else {
      console.warn('No SLACK_WEBHOOK_URL environment variable set.');
    }

    // 🔹 create Jira issue
    if (jiraSite && jiraEmail && jiraToken && jiraProjectKey) {
      const authHeader =
        'Basic ' +
        Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

      // Create a plain text version of the description
      const descriptionText = result.pretty
        .map(p => `${p.key}: ${p.value}`)
        .join('\n');

      // Wrap it in Atlassian Document Format
      const descriptionADF = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: descriptionText,
              },
            ],
          },
        ],
      };

      const issueBody = {
        fields: {
          project: { key: jiraProjectKey },
          summary: `${result.formTitle}: ${
            result.pretty[0]?.value || 'New Request'
          }`,
          description: descriptionADF,
          issuetype: { name: 'Task' }, // or 'Bug', 'Story', etc.
        },
      };

      const jiraRes = await fetch(`${jiraSite}/rest/api/3/issue`, {
        method: 'POST',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(issueBody),
      });

      if (!jiraRes.ok) {
        console.error(
          'Jira issue creation failed:',
          await jiraRes.text()
        );
      } else {
        const issueData = await jiraRes.json();
        console.log('Jira issue created:', issueData.key);
      }
    } else {
      console.warn(
        'Missing Jira environment variables; skipping ticket creation'
      );
    }

    return new Response(JSON.stringify({ ok: true, ...result }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('Error handling POST /api/report:', err);

    return new Response(
      JSON.stringify({
        ok: false,
        error: 'Could not parse form data or send to Slack/Jira',
      }),
      {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
