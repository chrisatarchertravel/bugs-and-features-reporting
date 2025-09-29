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

      // --- Improved normalization & parsing for Jotform "pretty" string ---
      raw = raw
        .trim()
        .replace(/^\s*pretty[:\s-]*/i, '') // remove accidental leading "pretty"
        .replace(/\\\//g, '/')            // unescape \/ -> /
        .replace(/\\"/g, '"')             // unescape \"
        .replace(/\\n/g, '\n');           // unescape \n

      function splitOnLabelBoundaries(s) {
        // If it already has one-per-line, respect lines
        if (/\r?\n/.test(s)) {
          return s.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
        }
        // Otherwise, split only where a *new label* starts:
        // pattern: ", " followed by Capitalized text that eventually has a colon.
        const marked = s.replace(/,\s+(?=[A-Z][^:]{0,200}:)/g, '|||');
        return marked.split('|||').map(t => t.trim()).filter(Boolean);
      }

      const parts = splitOnLabelBoundaries(raw);

      for (const part of parts) {
        // Use the LAST colon so labels may contain colons safely
        const lastColon = part.lastIndexOf(':');
        if (lastColon === -1) {
          if (part) prettyArray.push({ key: part.trim(), value: '' });
          continue;
        }
        const key = part.slice(0, lastColon).trim();
        const value = part.slice(lastColon + 1).trim();
        if (key) prettyArray.push({ key, value });
      }
      // --- end improved parsing ---
    }

    // -------------------------
    // URL extraction & normalization
    // -------------------------
    const urlRegex = /https?:\/\/[^\s"']+/gi;

    function extractUrlsFromObject(obj) {
      const out = [];
      if (obj == null) return out;

      if (typeof obj === 'string') {
        out.push(...extractUrlsFromStringOrJson(obj));
        return out;
      }

      if (Array.isArray(obj)) {
        for (const item of obj) {
          out.push(...extractUrlsFromObject(item));
        }
        return out;
      }

      if (typeof obj === 'object') {
        for (const k of Object.keys(obj)) {
          out.push(...extractUrlsFromObject(obj[k]));
        }
        return out;
      }

      return out;
    }

    function extractUrlsFromStringOrJson(s) {
      if (typeof s !== 'string') return [];
      const trimmed = s.trim();

      // If it looks like JSON (object/array), try to parse and recurse.
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
          const parsed = JSON.parse(s);
          return extractUrlsFromObject(parsed);
        } catch {
          // fall through to plain string extraction
        }
      }

      // Unescape common JSON-escaped slashes/quotes so regex sees real URLs
      const unescaped = s
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n');

      const matches = unescaped.match(urlRegex);
      return matches ? matches.map(m => m) : [];
    }

    // collect raw matches from every allData value
    let rawMatches = [];
    for (const val of Object.values(allData)) {
      rawMatches.push(...extractUrlsFromObject(val));
    }

    // normalize & dedupe matches
    const normalizedSet = new Set(
      rawMatches
        .map(u => {
          if (!u) return u;
          let nu = u.replace(/\\\//g, '/'); // just in case any escaped slashes remain

          // Normalize JotForm uploads -> files.jotform.com/jufs
          nu = nu.replace(
            /^https?:\/\/(?:www\.)?jotform\.com\/uploads/i,
            'https://files.jotform.com/jufs'
          );

          // trim trailing quotes or punctuation sometimes captured
          nu = nu.replace(/["'<>]+$/g, '');

          return nu;
        })
        .filter(Boolean)
    );

    const normalizedUrls = Array.from(normalizedSet);

    // Prefer file-like URLs
    const fileLikeUrls = normalizedUrls.filter(u =>
      /\.(png|jpe?g|gif|bmp|pdf|zip|txt|csv|docx?|xlsx?|webp)(\?.*)?$/i.test(u) ||
      /\/jufs\//i.test(u) ||
      /\/uploads\//i.test(u)
    );

    const finalUrls = fileLikeUrls.length > 0 ? fileLikeUrls : normalizedUrls;

    // Append attachments to prettyArray
    finalUrls.forEach((u, idx) => {
      prettyArray.push({ key: `Attachment ${idx + 1}`, value: u });
    });

    console.log('Detected URLs:', normalizedUrls);
    console.log('File-like URLs (used as attachments):', finalUrls);

    // -------------------------
    // Build result and continue with Slack/Jira logic
    // -------------------------
    const result = {
      formTitle: formTitle ?? '',
      pretty: prettyArray,
    };

    console.log('Parsed form data:', result);

    // 🔹 send to Slack
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
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
        'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

      const descriptionText = result.pretty
        .map(p => `${p.key}: ${p.value}`)
        .join('\n');

      const descriptionADF = {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: descriptionText }],
          },
        ],
      };

      const issueBody = {
        fields: {
          project: { key: jiraProjectKey },
          summary: `${result.formTitle}: ${result.pretty[0]?.value || 'New Request'}`,
          description: descriptionADF,
          issuetype: { name: 'Task' },
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
        console.error('Jira issue creation failed:', await jiraRes.text());
      } else {
        const issueData = await jiraRes.json();
        console.log('Jira issue created:', issueData.key);
      }
    } else {
      console.warn('Missing Jira environment variables; skipping ticket creation');
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
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }
}
