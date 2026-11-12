// routes/classification.js — the task classification matrix (public, read-only).
//
// GET /api/classification   industries, job types and the four execution modes

const express = require('express');
const { catalogue } = require('../services/classification');

const router = express.Router();

router.get('/', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(catalogue());
});

module.exports = router;
