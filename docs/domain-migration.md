# GifGadgets domain connectivity

gifgadgets.com is registered at Network Solutions. Its public DNS zone was
created manually in Route 53. Registration does not need to move to AWS.

The Terraform configuration adds gifgadgets.com and www.gifgadgets.com to
the existing site distribution and creates A alias records in that existing zone.
The old site hostname, assets certificate, buckets and shared-media URLs remain.
site.config.json sets the canonical origin to https://gifgadgets.com for rendered
HTML, robots.txt and sitemap.xml. The CloudFront function permanently redirects
gifwidgets.com and www.gifgadgets.com to the new apex, preserving paths and query
parameters. API and /share/ behaviors remain direct for existing clients. The
assets bucket CORS settings allow the new domains for uploads.

Before deployment:

1. Run `aws sso login --profile gifwidgets`.
2. Verify the supplied ACM certificate is Issued in us-east-1 and covers
   gifgadgets.com, www.gifgadgets.com and gifwidgets.com. CloudFront uses one
   certificate for all aliases on this distribution.
3. Verify registrar delegation matches the new zone's four NS values. Keep the
   certificate's DNS validation records for automatic renewal.
4. If new site A records were already created manually, import them into Terraform
   before applying; do not overwrite existing records blindly.
5. From `terraform/`, with the existing local secret variables available, run
   `AWS_PROFILE=gifwidgets terraform plan -var-file=gifgadgets.tfvars.example -out=gifgadgets.tfplan`.
   Review the complete plan before applying. Expected changes are two new A alias
   records, the site distribution's aliases and certificate, the redirect function
   and assets CORS. First provision with `-var=enable_domain_redirect=false`, verify
   new-domain DNS/HTTPS, then apply with the default true value. Investigate
   unrelated changes or any deletion/replacement. Keep saved plans out of Git;
   they can contain secrets.
6. Apply the reviewed plan with
   `AWS_PROFILE=gifwidgets terraform apply gifgadgets.tfplan`.
7. Wait for CloudFront deployment, then verify HTTPS on all three site hostnames,
   editor loading, API requests and existing content.gifwidgets.com share links.

The domain and certificate values are persisted in Terraform variable defaults;
future deployments do not need the example var-file. Rebuild/publish the frontend
and invalidate the site cache with this migration. `node tests/domain-redirect.cjs`
checks path/query preservation and normal directory rewriting. The smoke-test
script now targets gifgadgets.com.

Remaining account work: verify the new domain in Search Console, submit its
sitemap and use Change of Address for the old domain; update AdSense site approval
and the GA4 web-stream URL. Visual branding and mobile app references remain
separate from this domain migration.

The replacement certificate a9928a42-ece7-42f9-bd4b-069cc5ef9a2d was verified
Issued in us-east-1. It covers gifgadgets.com, *.gifgadgets.com, gifwidgets.com
and *.gifwidgets.com, including all planned site aliases. The example uses this
replacement ARN. The public gifgadgets.com hosted zone was confirmed as
Z03501823GAQ3BJLVAGU0.
