-- A tenant sees the files of their own repairs and their final statement (M8 review). 0041 opened
-- maintenance_job_attachment to the tenant whose job it is, but document's tenant policy (0022)
-- still showed only lease, signing and receipt documents, so the tenant app's repairs listed no
-- files. The tenant sees a job's report, before and after files (what the work was and what was
-- done); `other` files are staff's own. Applied as rent_owner, after 0041.

DROP POLICY tenant_scope ON maintenance_job_attachment;
CREATE POLICY tenant_scope ON maintenance_job_attachment AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL OR (
    maintenance_job_attachment.stage IN ('report', 'before', 'after')
    AND EXISTS (
      SELECT 1 FROM maintenance_job j
      WHERE j.company_id = maintenance_job_attachment.company_id AND j.id = maintenance_job_attachment.job_id
        AND j.tenant_id = ANY(app.tenant_scope()))));

DROP POLICY tenant_visible ON document;
CREATE POLICY tenant_visible ON document AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = document.company_id AND l.signed_document_id = document.id)
  OR EXISTS (SELECT 1 FROM signing_request r WHERE r.company_id = document.company_id
             AND document.id IN (r.document_id, r.html_document_id, r.final_document_id))
  OR EXISTS (SELECT 1 FROM receipt rc
             JOIN document_render_request q ON q.company_id = rc.company_id AND q.id = rc.render_request_id
             WHERE rc.company_id = document.company_id AND q.document_id = document.id)
  -- M8: a file on the tenant's own repair, at a stage they see (the attachment's policy above).
  OR EXISTS (SELECT 1 FROM maintenance_job_attachment a
             JOIN maintenance_job j ON j.company_id = a.company_id AND j.id = a.job_id
             WHERE a.company_id = document.company_id AND a.document_id = document.id
               AND a.stage IN ('report', 'before', 'after')
               AND j.tenant_id = ANY(app.tenant_scope()))
  -- M8: the final statement of the tenant's own move-out, once approved (move_out's policy).
  OR EXISTS (SELECT 1 FROM move_out m WHERE m.company_id = document.company_id
             AND m.statement_document_id = document.id));
