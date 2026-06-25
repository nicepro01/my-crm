const https = require('https');
const http = require('http');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  try {
    const { audioBase64, mimeType, fileName, leadName } = JSON.parse(event.body);
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return { statusCode: 500, body: JSON.stringify({ error: 'OpenAI API key not configured' }) };
    }

    // Convert base64 to buffer
    const audioBuffer = Buffer.from(audioBase64, 'base64');

    // Build multipart form data
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    const ext = (fileName || 'audio.mp3').split('.').pop() || 'mp3';
    const safeFileName = `audio.${ext}`;

    const formParts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1`,
      `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nru`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeFileName}"\r\nContent-Type: ${mimeType || 'audio/mpeg'}\r\n\r\n`,
    ];

    const prologue = Buffer.from(formParts.join('\r\n') + '\r\n', 'utf8');
    const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
    const body = Buffer.concat([prologue, audioBuffer, epilogue]);

    // Step 1: Transcribe with Whisper
    const transcription = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from Whisper: ' + data)); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (!transcription.text) {
      return { statusCode: 500, body: JSON.stringify({ error: transcription.error?.message || 'Transcription failed' }) };
    }

    const transcript = transcription.text;

    // Step 2: Summarize with GPT
    const summaryPayload = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{
        role: 'system',
        content: 'Ты помощник менеджера по закупкам из Китая. Сделай краткое саммари звонка на русском языке. Формат: 3-5 пунктов. Укажи: о чём говорили, что решили, следующие шаги. Будь кратким.'
      }, {
        role: 'user',
        content: `Клиент: ${leadName || 'Неизвестно'}\n\nРасшифровка звонка:\n${transcript}`
      }],
      max_tokens: 500,
    });

    const summary = await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(summaryPayload),
        },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON from GPT: ' + data)); }
        });
      });
      req.on('error', reject);
      req.write(summaryPayload);
      req.end();
    });

    const summaryText = summary.choices?.[0]?.message?.content || 'Не удалось создать саммари';

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, summary: summaryText }),
    };

  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
