require('dotenv').config();

const express = require('express');
const path = require('path');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const { readData, writeData } = require('./store');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/status', (req, res) => {
  res.json({ ai: !!process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'openrouter/free' });
});

app.get('/api/habits', (req, res) => {
  const { habits } = readData();
  res.json([...habits].sort((a, b) => a.name.localeCompare(b.name)));
});

app.post('/api/habits', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  const data = readData();
  const id = uuidv4();
  data.habits.push({ id, name: name.trim(), created_at: new Date().toISOString() });
  writeData(data);
  res.json({ id, name: name.trim() });
});

app.delete('/api/habits/:id', (req, res) => {
  const { id } = req.params;
  const data = readData();
  data.habits = data.habits.filter(h => h.id !== id);
  data.logs = data.logs.filter(l => l.habit_id !== id);
  writeData(data);
  res.json({ ok: true });
});

app.get('/api/habits/:id/logs', (req, res) => {
  const { id } = req.params;
  const { logs } = readData();
  res.json(logs.filter(l => l.habit_id === id).sort((a, b) => a.date.localeCompare(b.date)));
});

app.post('/api/habits/:id/toggle', (req, res) => {
  const { id } = req.params;
  const { date } = req.body;
  const today = date || new Date().toISOString().split('T')[0];
  const data = readData();
  const idx = data.logs.findIndex(l => l.habit_id === id && l.date === today);
  if (idx !== -1) {
    data.logs.splice(idx, 1);
    writeData(data);
    return res.json({ completed: false });
  }
  data.logs.push({ id: uuidv4(), habit_id: id, date: today, completed: 1 });
  writeData(data);
  res.json({ completed: true });
});

app.post('/api/habits/:id/toggle/force', (req, res) => {
  const { id } = req.params;
  const { date, completed } = req.body;
  const today = date || new Date().toISOString().split('T')[0];
  const data = readData();
  const existing = data.logs.find(l => l.habit_id === id && l.date === today);
  if (existing) {
    if (!completed) {
      data.logs = data.logs.filter(l => !(l.habit_id === id && l.date === today));
    }
  } else if (completed) {
    data.logs.push({ id: uuidv4(), habit_id: id, date: today, completed: 1 });
  }
  writeData(data);
  res.json({ completed: !!completed });
});

app.post('/api/ai', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: 'Text required' });

    const { habits } = readData();
    if (habits.length === 0) {
      return res.json({ matched: [], message: 'Добавьте хотя бы одну привычку, чтобы ИИ мог с ней работать.' });
    }

    const habitNames = habits.map(h => h.name).join(', ');
    const prompt = `Ты ассистент трекера привычек. Пользователь написал: "${text}".
Существующие привычки: ${habitNames}.
Сопоставь действия пользователя с привычками. Ответь ТОЛЬКО JSON массивом объектов вида:
[{"habit":"<имя привычки>", "completed": true/false}]
Если привычка не упомянута, не добавляй её. Если неясно — completed: false.
Пример: [{"habit":"Бег", "completed": true}, {"habit":"Чтение", "completed": true}, {"habit":"Английский", "completed": false}]
Верни только JSON без markdown-блоков и лишнего текста.`;

    const aiResponse = await callLLM(prompt);
    let matches;
    try {
      matches = JSON.parse(aiResponse);
      if (!Array.isArray(matches)) matches = [];
    } catch (e) {
      const cleaned = aiResponse.replace(/```json\n?|```\n?/g, '').trim();
      try {
        matches = JSON.parse(cleaned);
        if (!Array.isArray(matches)) matches = [];
      } catch (e2) {
        return res.status(500).json({ error: 'Invalid AI response', raw: aiResponse });
      }
    }

    const results = [];
    const today = new Date().toISOString().split('T')[0];
    for (const match of matches) {
      const habit = habits.find(h => h.name === match.habit);
      if (!habit) continue;
      const data = readData();
      const existing = data.logs.find(l => l.habit_id === habit.id && l.date === today);
      if (match.completed && !existing) {
        data.logs.push({ id: uuidv4(), habit_id: habit.id, date: today, completed: 1 });
        writeData(data);
      } else if (!match.completed && existing) {
        data.logs = data.logs.filter(l => !(l.habit_id === habit.id && l.date === today));
        writeData(data);
      }
      results.push({ habit: habit.name, completed: match.completed });
    }

    res.json({ matched: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function callLLM(prompt) {
  const apiKey = process.env.LLM_API_KEY;
  const baseURL = process.env.LLM_BASE_URL || 'https://openrouter.ai/api/v1';
  const model = process.env.LLM_MODEL || 'openrouter/free';

  return fetch(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })
  }).then(async (r) => {
    if (!r.ok) {
      const err = await r.text().catch(() => '');
      throw new Error(`LLM API error: ${r.status} ${err}`);
    }
    const data = await r.json();
    return data.choices[0].message.content;
  });
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
