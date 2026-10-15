/**
 * zod checks once whether it may compile parsers with `new Function`. Under a
 * content security policy without 'unsafe-eval' (the web app's), the browser
 * blocks that check and reports a policy violation, although zod catches the
 * error. `jitless` skips the check; parsing is unchanged. The check runs when an
 * object schema is built, so every module of this package that builds schemas
 * imports this one first, and it runs before any module that imports the
 * package builds its own schemas.
 */
import { config } from 'zod';

config({ jitless: true });
