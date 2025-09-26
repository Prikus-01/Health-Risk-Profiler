import express from 'express';
import dotenv from 'dotenv';
import multer from 'multer';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import { CLIENT_RENEG_LIMIT } from 'tls';
import { GoogleGenAI } from "@google/genai";
const ai = new GoogleGenAI({ apiKey: "AIzaSyB6HsTiL9LrjgiWk4Y2scbcm8ghdiY4p0g" });

dotenv.config();
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Parse text input (robust against messy OCR output)
const parseTextInput = (text) => {
  try {
    if (text && typeof text === 'object') return text; // already parsed
    if (!text || typeof text !== 'string') return null;

    // Normalize newlines and strip wrapping braces if any
    let raw = String(text)
      .replace(/^[\s{\[]+/, '')
      .replace(/[\s}\]]+$/, '')
      .replace(/\r\n/g, '\n');

    // Try relaxed JSON parse by removing trailing commas and fixing common OCR quirks
    const relaxed = raw
      .replace(/,\s*\n/g, '\n')      // remove commas at end of lines
      .replace(/\s+,\s*$/m, '')       // trailing comma at the very end
      .trim();

    // If it still looks like JSON inside, try to parse
    if (relaxed.startsWith('"') || relaxed.includes('":"') || relaxed.includes('\":')) {
      try {
        const attempt = `{${relaxed}}`;
        const jsonFixed = attempt
          // Replace single quotes around keys/values with double quotes (common OCR issue)
          .replace(/([,{\s])'([^']+?)'\s*:/g, '$1"$2":')
          .replace(/:\s*'([^']+?)'/g, ':"$1"')
          // Remove extra commas directly before closing brace
          .replace(/,\s*}/g, '}');
        const parsed = JSON.parse(jsonFixed);
        return parsed;
      } catch (_) {
        // fall back to KV parsing
      }
    }

    // Key-Value parsing per line
    const lines = relaxed.split('\n').filter(l => l.trim() !== '');
    const result = {};

    for (let line of lines) {
      // Drop trailing commas and surrounding spaces
      line = line.replace(/,\s*$/, '').trim();
      if (!line) continue;

      // Match key : value while tolerating stray quotes/spaces
      const m = line.match(/^\s*["']?\s*([^:"']+?)\s*["']?\s*:\s*(.+)$/);
      if (!m) continue;

      let key = m[1]
        .replace(/["']/g, '')      // remove quotes/apostrophes
        .trim()
        .toLowerCase();

      let valueStr = m[2].trim();
      // Remove trailing commas
      valueStr = valueStr.replace(/,\s*$/, '').trim();
      // Remove wrapping quotes if present
      if ((valueStr.startsWith('"') && valueStr.endsWith('"')) ||
          (valueStr.startsWith("'") && valueStr.endsWith("'"))) {
        valueStr = valueStr.slice(1, -1);
      }

      const lower = valueStr.toLowerCase();
      let value;
      if (lower === 'yes' || lower === 'true') value = true;
      else if (lower === 'no' || lower === 'false') value = false;
      else if (/^-?\d+(?:\.\d+)?$/.test(valueStr)) value = Number(valueStr);
      else value = valueStr;

      result[key] = value;
    }

    return result;
  } catch (e) {
    console.error('Error parsing text input:', e);
    return null;
  }
};

// Process image using OCR
const processImageWithOCR = async (imagePath) => {
    try {
        const b64 = fs.readFileSync(imagePath, { encoding: 'base64' });
        const params = new URLSearchParams();
        params.append('apikey', process.env.OCR_SPACE_API_KEY);
        params.append('base64image', `data:image/jpeg;base64,${b64}`);
        params.append('filetype', 'png');
        // Optional: control recognition
        // params.append('ocrengine', '2'); // sometimes improves accuracy

        const response = await fetch('https://api.ocr.space/parse/image', {
        method: 'POST',
        body: params
        // Do not set Content-Type manually; URLSearchParams sets it properly
        });
        
        const data = await response.json();
        if (data.IsErroredOnProcessing) {
            throw new Error('OCR processing failed');
        }
        
        const extractedText = data.ParsedResults[0].ParsedText;
        return parseTextInput(extractedText);
    } catch (error) {
        console.error('Error processing image with OCR:', error);
        return null;
    }
};

// Validate survey answers
const validateSurveyAnswers = (answers) => {
    const requiredFields = ['age', 'smoker', 'exercise', 'diet'];
    const missingFields = [];
    const result = { age: 0, smoker: false, exercise: '', diet: '' };
    
    // Check for missing fields and normalize data
    requiredFields.forEach(field => {
        if (answers[field] === undefined || answers[field] === '') {
            missingFields.push(field);
        } else {
            result[field] = answers[field];
        }
    });
    
    // Convert age to number if it's a string
    if (typeof result.age === 'string') {
        result.age = parseInt(result.age, 10) || 0;
    }
    
    // Convert smoker to boolean if it's a string
    if (typeof result.smoker === 'string') {
        result.smoker = result.smoker.toLowerCase() === 'true' || result.smoker.toLowerCase() === 'yes';
    }
    
    // Calculate confidence based on filled fields
    const confidence = 1 - (missingFields.length / requiredFields.length);
    
    return {
        answers: result,
        missing_fields: missingFields,
        confidence: parseFloat(confidence.toFixed(2))
    };
};

// Process survey submission
const processSurveySubmission = async (input) => {
    let parsedData;
    // Handle different input types
    if (input.text) {
        parsedData = input.text;
    } else if (input.image) {
        parsedData = await processImageWithOCR(input.image);
    } else {
        return {
            status: 'error',
            message: 'No valid input provided. Please provide either text or image.'
        };
    }
    
    if (!parsedData) {
        return {
            status: 'error',
            message: 'Failed to parse input data.'
        };
    }
    
    const validationResult = validateSurveyAnswers(parsedData);
    
    // Check if more than 50% of fields are missing
    if (validationResult.missing_fields.length > 2) {
        return {
            status: 'incomplete_profile',
            reason: '>50% fields missing'
        };
    }
    
    return validationResult;
};

// Routes
app.post('/api/survey', upload.single('image'), async (req, res) => {
    try {
        let input = {};
        // Handle text input
        if (req.body.text) {
            input.text = req.body.text;
        } 
        // Handle file upload
        else if (req.file) {
            input.image = req.file.path;
        }
        
        const result = await processSurveySubmission(input);
        
        // Clean up uploaded file if it exists
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        
        res.json(result);
    } catch (error) {
        console.error('Error processing survey:', error);
        res.status(500).json({
            status: 'error',
            message: 'An error occurred while processing the survey.'
        });
    }
});

app.post('/api/recom', async (req, res) => {
    const { age, smoker, exercise, diet } = req.body;
    try {
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `You are a health assistant.
Return ONLY valid JSON. No code fences. Use exactly these keys:
risk_level ("low"|"medium"|"high"), factors (array of short strings), recommendations (array of short actionable phrases), status (always "ok").
Keep guidance non-diagnostic, practical, and concise.
Inputs: age: ${age}, smoker: ${smoker}, exercise: ${exercise}, diet: ${diet}`,
        });

        const raw = response?.text ?? '';
        const toJson = (s) => {
            if (!s || typeof s !== 'string') return null;
            s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
                s = s.slice(1, -1);
            }
            try { return JSON.parse(s); } catch (_) {}
            const m = s.match(/\{[\s\S]*\}/);
            if (m) {
                try { return JSON.parse(m[0]); } catch (_) {}
            }
            return null;
        };

        const normalizeLevel = (lvl) => {
            if (!lvl) return '';
            const l = String(lvl).toLowerCase();
            if (["low", "medium", "high"].includes(l)) return l;
            if (l.includes('med')) return 'medium';
            if (l.includes('hi')) return 'high';
            if (l.includes('lo')) return 'low';
            return '';
        };

        const parsed = toJson(raw) || {};
        let risk_level = normalizeLevel(parsed.risk_level);
        let factors = Array.isArray(parsed.factors) ? parsed.factors.filter(x => typeof x === 'string') : [];
        let recommendations = Array.isArray(parsed.recommendations) ? parsed.recommendations.filter(x => typeof x === 'string') : [];
        let status = typeof parsed.status === 'string' ? parsed.status : '';

        const fallback = () => {
            const a = Number(age) || 0;
            const isSmoker = (typeof smoker === 'string') ? (/^(true|yes|1)$/i).test(smoker) : !!smoker;
            const ex = (String(exercise || '')).toLowerCase();
            const dt = (String(diet || '')).toLowerCase();

            // Simple score similar to /api/risk-level
            let sc = 0; const why = [];
            if (a >= 60) { sc += 30; why.push('older age'); }
            else if (a >= 45) { sc += 20; why.push('middle age'); }
            if (isSmoker) { sc += 30; why.push('smoking'); }
            if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) { sc += 20; why.push('low exercise'); }
            else if (/(moderate|sometimes|1-2x)/.test(ex)) { sc += 10; why.push('moderate activity'); }
            if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) { sc += 20; why.push('poor diet'); }
            else if (/(mixed|average)/.test(dt)) { sc += 10; why.push('average diet'); }

            const recs = [];
            if (isSmoker) recs.push('Quit smoking');
            if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) recs.push('Reduce sugar');
            if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) recs.push('Walk 30 mins daily');
            if (!recs.includes('Aim for 150 mins weekly activity')) recs.push('Aim for 150 mins weekly activity');
            if (!recs.includes('Add fruits and vegetables')) recs.push('Add fruits and vegetables');

            return { risk_level: (sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low'), factors: why.slice(0, 6), recommendations: recs.slice(0, 8), status: 'ok' };
        };

        const valid = risk_level && factors.length > 0 && recommendations.length > 0 && status.toLowerCase() === 'ok';
        if (!valid) {
            const fb = fallback();
            return res.json(fb);
        }

        return res.json({ risk_level, factors: factors.slice(0, 6), recommendations: recommendations.slice(0, 8), status: 'ok' });
    } catch (err) {
        console.error('Error in /api/recom:', err);
        // Fallback on error
        const a = Number(age) || 0;
        const isSmoker = (typeof smoker === 'string') ? (/^(true|yes|1)$/i).test(smoker) : !!smoker;
        const ex = (String(exercise || '')).toLowerCase();
        const dt = (String(diet || '')).toLowerCase();

        let sc = 0; const why = [];
        if (a >= 60) { sc += 30; why.push('older age'); }
        else if (a >= 45) { sc += 20; why.push('middle age'); }
        if (isSmoker) { sc += 30; why.push('smoking'); }
        if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) { sc += 20; why.push('low exercise'); }
        else if (/(moderate|sometimes|1-2x)/.test(ex)) { sc += 10; why.push('moderate activity'); }
        if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) { sc += 20; why.push('poor diet'); }
        else if (/(mixed|average)/.test(dt)) { sc += 10; why.push('average diet'); }

        const recs = [];
        if (isSmoker) recs.push('Quit smoking');
        if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) recs.push('Reduce sugar');
        if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) recs.push('Walk 30 mins daily');
        if (!recs.includes('Aim for 150 mins weekly activity')) recs.push('Aim for 150 mins weekly activity');
        if (!recs.includes('Add fruits and vegetables')) recs.push('Add fruits and vegetables');

        return res.status(200).json({
            risk_level: (sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low'),
            factors: why.slice(0, 6),
            recommendations: recs.slice(0, 8),
            status: 'ok'
        });
    }
});

app.post('/api/risk', async (req, res) => {
    try {
    const { age, smoker, exercise, diet } = req.body;
    const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
            contents: `You are a health risk profiler.
Return ONLY valid JSON. No code fences. Use keys exactly: factors (array of strings), confidence (number 0..1).
Inputs: age: ${age}, smoker: ${smoker}, exercise: ${exercise}, diet: ${diet}`,
        });

        const raw = response?.text ?? '';

        // Helper to extract JSON from possible markdown/code fences
        const toJson = (s) => {
            if (!s || typeof s !== 'string') return null;
            // Strip common code fences ```json ... ``` or ``` ... ```
            s = s.replace(/^```[a-zA-Z]*\n?/,'').replace(/```\s*$/,'');
            // If surrounded by quotes accidentally, remove
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                s = s.slice(1, -1);
            }
            // Try direct parse
            try { return JSON.parse(s); } catch (_) {}
            // Fallback: find first JSON object in text
            const m = s.match(/\{[\s\S]*\}/);
            if (m) {
                try { return JSON.parse(m[0]); } catch (_) {}
            }
            return null;
        };

        const parsed = toJson(raw) || { factors: [], confidence: 0 };
        const factors = Array.isArray(parsed.factors) ? parsed.factors : [];
        let confidence = Number(parsed.confidence);
        if (!Number.isFinite(confidence)) confidence = 0;
        return res.json({ factors, confidence });
    } catch (err) {
        console.error('Error in /api/risk:', err);
        return res.status(500).json({ status: 'error', message: 'Failed to parse model response' });
    }
});

app.post('/api/risk-level', async (req, res) => {   
    const { age, smoker, exercise, diet } = req.body;
    try {
        // Ask Gemini to compute a simple non-diagnostic score and rationale
        const response = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: `You are a health risk profiler.
Return ONLY valid JSON. No code fences. Keys exactly: risk_level (one of: low, medium, high), score (integer 0..100), rationale (array of short strings).
Use a simple, non-diagnostic scoring based on inputs. Be concise.
Inputs: age: ${age}, smoker: ${smoker}, exercise: ${exercise}, diet: ${diet}`,
        });

        const raw = response?.text ?? '';

        // JSON extraction helper (same approach as /api/risk)
        const toJson = (s) => {
            if (!s || typeof s !== 'string') return null;
            s = s.replace(/^```[a-zA-Z]*\n?/, '').replace(/```\s*$/, '');
            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
                s = s.slice(1, -1);
            }
            try { return JSON.parse(s); } catch (_) {}
            const m = s.match(/\{[\s\S]*\}/);
            if (m) {
                try { return JSON.parse(m[0]); } catch (_) {}
            }
            return null;
        };

        const parsed = toJson(raw) || {};
        let risk_level = typeof parsed.risk_level === 'string' ? parsed.risk_level.toLowerCase() : '';
        let score = Number.isFinite(Number(parsed.score)) ? Math.round(Number(parsed.score)) : NaN;
        let rationale = Array.isArray(parsed.rationale) ? parsed.rationale.filter(x => typeof x === 'string') : [];

        const normalizeLevel = (lvl) => {
            if (!lvl) return '';
            if (["low", "medium", "high"].includes(lvl)) return lvl;
            // map common variants
            if (lvl.includes('med')) return 'medium';
            if (lvl.includes('hi')) return 'high';
            if (lvl.includes('lo')) return 'low';
            return '';
        };
        risk_level = normalizeLevel(risk_level);

        // If model output unusable, compute a deterministic fallback
        const fallback = () => {
            const a = Number(age) || 0;
            const isSmoker = (typeof smoker === 'string') ? (/^(true|yes|1)$/i).test(smoker) : !!smoker;
            const ex = (String(exercise || '')).toLowerCase();
            const dt = (String(diet || '')).toLowerCase();

            let sc = 0;
            const why = [];

            if (a >= 60) { sc += 30; why.push('older age'); }
            else if (a >= 45) { sc += 20; why.push('middle age'); }

            if (isSmoker) { sc += 30; why.push('smoking'); }

            if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) { sc += 20; why.push('low activity'); }
            else if (/(moderate|sometimes|1-2x)/.test(ex)) { sc += 10; why.push('moderate activity'); }

            if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) { sc += 20; why.push('high sugar diet'); }
            else if (/(mixed|average)/.test(dt)) { sc += 10; why.push('average diet'); }

            if (sc > 100) sc = 100;
            const lvl = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
            return { risk_level: lvl, score: sc, rationale: why.slice(0, 6) };
        };

        if (!risk_level || !Number.isFinite(score) || score < 0 || score > 100 || rationale.length === 0) {
            const fb = fallback();
            return res.json(fb);
        }

        return res.json({ risk_level, score, rationale: rationale.slice(0, 6) });
    } catch (err) {
        console.error('Error in /api/risk-level:', err);
        // Final fallback on error
        const a = Number(age) || 0;
        const isSmoker = (typeof smoker === 'string') ? (/^(true|yes|1)$/i).test(smoker) : !!smoker;
        const ex = (String(exercise || '')).toLowerCase();
        const dt = (String(diet || '')).toLowerCase();

        let sc = 0; const why = [];
        if (a >= 60) { sc += 30; why.push('older age'); }
        else if (a >= 45) { sc += 20; why.push('middle age'); }
        if (isSmoker) { sc += 30; why.push('smoking'); }
        if (/(sedentary|low|rare|none|0x|inactive)/.test(ex)) { sc += 20; why.push('low activity'); }
        else if (/(moderate|sometimes|1-2x)/.test(ex)) { sc += 10; why.push('moderate activity'); }
        if (/(high\s*sugar|junk|processed|unhealthy|sweets|soda|fast\s*food)/.test(dt)) { sc += 20; why.push('high sugar diet'); }
        else if (/(mixed|average)/.test(dt)) { sc += 10; why.push('average diet'); }
        if (sc > 100) sc = 100;
        const lvl = sc >= 70 ? 'high' : sc >= 40 ? 'medium' : 'low';
        return res.status(200).json({ risk_level: lvl, score: sc, rationale: why.slice(0, 6) });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok',
        timestamp: new Date().toISOString()
    });
});

// 404 error handler
app.use((req, res) => {
    res.status(404).json({
        status: 'error',
        message: 'Endpoint not found'
    });
});

// Error handling middleware
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({
        status: 'error',
        message: 'Internal server error'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server started on port ${PORT}`);
});

