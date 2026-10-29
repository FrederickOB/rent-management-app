import { TemplateRegistry } from './registry';
import { systemSampleV1 } from './system-sample';

/** Every template the product renders. Old versions stay, so stored documents keep theirs. */
export const templates = new TemplateRegistry([systemSampleV1]);
