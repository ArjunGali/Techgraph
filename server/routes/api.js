import { Router } from 'express';
import { live, health } from '../controllers/health.controller.js';
import * as explore from '../controllers/explore.controller.js';
import * as career from '../controllers/career.controller.js';
import * as paths from '../controllers/paths.controller.js';
import { careerBuilder } from '../controllers/builder.controller.js';

// Routes only map URLs to controllers — no logic lives here.
const router = Router();

router.get('/live', live);     // liveness only — used by the platform health check
router.get('/health', health); // liveness + database dependency status

// Explorer / Dashboard
router.get('/search', explore.search);
router.get('/stats', explore.stats);
router.get('/entities/:label/:name', explore.getEntity);
router.get('/entities/:label/:name/relationships', explore.getEntityRelationships);

// Career
router.get('/jobs/requiring/:skill', career.jobsRequiringSkill);
router.get('/technologies/:name/related', career.relatedTechnologies);
router.get('/career-path', career.careerPath);
router.get('/study-path', career.studyPath);
router.get('/employers-for-skill', career.employersForSkill);
router.get('/career-builder', careerBuilder);

// Connection Explorer
router.get('/connection-path', paths.connectionPath);

export default router;
