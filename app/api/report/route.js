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
        .replace(/^\s*pretty[:\s-]*/i, '')
        .replace(/\\\//g, '/')
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n');

      function splitOnLabelBoundaries(s) {
        if (/\r?\n/.test(s)) {
          return s.split(/\r?\n/).map(t => t.trim()).filter(Boolean);
        }
        const marked = s.replace(/,\s+(?=[A-Z][^:]{0,200}:)/g, '|||');
        return marked.split('|||').map(t => t.trim()).filter(Boolean);
      }

      const parts = splitOnLabelBoundaries(raw);

      for (const part of parts) {
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
          // e.g. https://www.jotform.com/uploads/...  -> https://files.jotform.com/jufs/...
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

    // ---- STRICT file-attachment detection (images + common docs like PDF) ----
    const FILE_EXT_RE = /\.(png|jpe?g|gif|bmp|webp|tiff?|heic|pdf|docx?|xlsx?|csv|txt|zip)(\?.*)?$/i;

    function isFileAttachment(u) {
      try {
        const url = new URL(u);
        const host = url.hostname.toLowerCase();
        const path = url.pathname;

        // Exclude obvious non-file endpoints
        if (/\/api\/report(?:\/|$)/i.test(path)) return false;
        if (host.includes('upload.jotform.com') && /^\/upload\/?$/i.test(path)) return false;

        // Direct file by allowed extension (incl. .pdf)
        if (FILE_EXT_RE.test(path)) return true;

        // Jotform hosted file via /jufs/.../<filename> with an allowed extension
        if (
          (host.endsWith('jotform.com') || host.endsWith('jotform.me') || host.endsWith('files.jotform.com')) &&
          /\/jufs\//i.test(path) &&
          FILE_EXT_RE.test(path)
        ) {
          return true;
        }

        return false;
      } catch {
        // Fallback: quick string tests
        if (/\/api\/report\b/i.test(u)) return false;
        if (/upload\.jotform\.com\/upload\/?$/i.test(u)) return false;
        return /\/jufs\//i.test(u) && FILE_EXT_RE.test(u);
      }
    }

    // Only keep TRUE file attachments (now includes PDFs)
    const fileAttachmentUrls = normalizedUrls.filter(isFileAttachment);

    // Append attachments ONLY if we found real files
    fileAttachmentUrls.forEach((u, idx) => {
      prettyArray.push({ key: `Attachment ${idx + 1}`, value: u });
    });

    console.log('Detected URLs (all):', normalizedUrls);
    console.log('File attachments (used as attachments):', fileAttachmentUrls);

    // -------------------------
    // Build result and continue with Slack/Jira logic
    // -------------------------
    const result = {
      formTitle: formTitle ?? '',
      pretty: prettyArray,
    };

    console.log('Parsed form data:', result);

    // 🔹 send to Slack — plain answers so URLs autolink correctly
    const webhookUrl = process.env.SLACK_WEBHOOK_URL;
    if (webhookUrl) {
      const textLines = [
        `*${result.formTitle}*`,
        ...result.pretty.map(p => `• *${p.key}*: ${p.value || ''}`),
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

    // 🔹 create Jira issue (answers underlined; URLs clickable)
    if (jiraSite && jiraEmail && jiraToken && jiraProjectKey) {
      const authHeader =
        'Basic ' + Buffer.from(`${jiraEmail}:${jiraToken}`).toString('base64');

      // Helper: build text node for value; if URL, add link+underline marks
      const URL_VALUE_RE = /^https?:\/\/\S+$/i;
      function valueNode(value) {
        if (!value) return [];
        if (URL_VALUE_RE.test(value)) {
          return [
            {
              type: 'text',
              text: value,
              marks: [
                { type: 'link', attrs: { href: value } },
                { type: 'underline' },
              ],
            },
          ];
        }
        return [{ type: 'text', text: value, marks: [{ type: 'underline' }] }];
      }

      const descriptionADF = {
        type: 'doc',
        version: 1,
        content: result.pretty.length
          ? result.pretty.map(p => ({
              type: 'paragraph',
              content: [
                { type: 'text', text: `${p.key}: ` },
                ...valueNode(p.value),
              ],
            }))
          : [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }],
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
