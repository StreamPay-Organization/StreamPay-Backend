'use strict';

const { Router } = require('express');
const streamController = require('../controllers/streamController');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const ApiError = require('../utils/ApiError');
const { validateCreateStream, validateWithdraw } = require('../validators/streamValidators');
const methodNotAllowed = require('../middleware/methodNotAllowed');
const mutationRateLimit = require('../middleware/mutationRateLimit');
const { validateBatchUpdate } = require('../validators/streamValidators');

const router = Router();

// Guard the :id param so obviously malformed ids short-circuit to a 400.
router.param('id', (req, res, next, id) => {
  if (typeof id !== 'string' || !id.startsWith('stream_')) {
    return next(ApiError.badRequest('Invalid stream id'));
  }
  next();
});

router.route('/streams')
  .post(mutationRateLimit('stream.create'), validate(validateCreateStream), asyncHandler(streamController.create))
  .get(streamController.list)
  .all(methodNotAllowed);

router.route('/streams/batch')
  .post(mutationRateLimit('stream.batch'), validate(validateBatchUpdate), asyncHandler(streamController.batchUpdate))
  .all(methodNotAllowed);

router.route('/streams/:id')
  .get(streamController.getById)
  .all(methodNotAllowed);

router.route('/streams/:id/schedule')
  .get(streamController.getSchedule)
  .all(methodNotAllowed);

router.route('/streams/:id/stats')
  .get(streamController.getStats)
  .all(methodNotAllowed);

router.route('/streams/:id/withdraw')
  .post(mutationRateLimit('stream.withdraw'), validate(validateWithdraw), asyncHandler(streamController.withdraw))
  .all(methodNotAllowed);

router.route('/streams/:id/cancel')
  .post(mutationRateLimit('stream.cancel'), asyncHandler(streamController.cancel))
  .all(methodNotAllowed);

module.exports = router;
