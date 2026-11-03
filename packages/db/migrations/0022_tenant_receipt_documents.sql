-- A tenant session reads the documents of its own receipts (M4b links and tenant e2e: every
-- `GET /me/receipts/{id}/download` answered 404). Migration 0011 let a tenant session see a
-- document or render request only of its own signing request or signed lease. A receipt's PDF is
-- found through the receipt's render request; receipts are tenant-scoped (0013), so the tenant
-- sees only its own, never another tenant's in the same company. No tenant route serves invoice
-- PDFs (the pay page's invoice is read in the link context, which has no tenant scope), so
-- invoices are not added. Applied as rent_owner.

DROP POLICY tenant_visible ON document_render_request;
CREATE POLICY tenant_visible ON document_render_request AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM signing_request r WHERE r.company_id = document_render_request.company_id
             AND r.render_request_id = document_render_request.id)
  OR EXISTS (SELECT 1 FROM receipt rc WHERE rc.company_id = document_render_request.company_id
             AND rc.render_request_id = document_render_request.id));

DROP POLICY tenant_visible ON document;
CREATE POLICY tenant_visible ON document AS RESTRICTIVE USING (
  app.tenant_scope() IS NULL
  OR EXISTS (SELECT 1 FROM lease l WHERE l.company_id = document.company_id AND l.signed_document_id = document.id)
  OR EXISTS (SELECT 1 FROM signing_request r WHERE r.company_id = document.company_id
             AND document.id IN (r.document_id, r.html_document_id, r.final_document_id))
  OR EXISTS (SELECT 1 FROM receipt rc
             JOIN document_render_request q ON q.company_id = rc.company_id AND q.id = rc.render_request_id
             WHERE rc.company_id = document.company_id AND q.document_id = document.id));
