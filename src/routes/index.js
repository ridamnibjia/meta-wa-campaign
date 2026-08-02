'use strict';
const express = require('express');
const { requireAuth } = require('../middleware/auth');

// Route order is the security boundary here. /webhook mounts first and stays
// unauthenticated (Meta signs it instead); everything after requireAuth needs a
// session. Adding a new router below the gate is what keeps it protected by
// default — the safe thing happens when you do nothing special.
function mount(app) {
  app.use('/', require('./webhook'));

  const api = express.Router();
  api.use(requireAuth);
  api.use(require('./settings'));
  api.use(require('./contacts'));
  api.use(require('./templates'));
  api.use(require('./campaign'));
  api.use(require('./inbox'));
  app.use('/api', api);
}

module.exports = { mount };
