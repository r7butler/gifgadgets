variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "expected_account_id" {
  description = "Optional AWS account ID safety check. If set, Terraform will fail fast when run against a different account."
  type        = string
  default     = "425750453898"
  nullable    = true
}

variable "project_slug" {
  description = "Slug used for naming AWS resources"
  type        = string
  default     = "gifwidgets"
}

variable "site_brand_name" {
  description = "Human-friendly brand name used in descriptions and comments"
  type        = string
  default     = "GifGadgets"
}

variable "site_bucket_name" {
  description = "Name of the S3 bucket for the static site"
  type        = string
  default     = "gifwidgets-site-prod"
}

variable "assets_bucket_name" {
  description = "Name of the S3 bucket for GIF assets"
  type        = string
  default     = "gifwidgets-assets-prod"
}

variable "root_domain_name" {
  description = "Root custom domain for the site"
  type        = string
  default     = "gifwidgets.com"
}

variable "assets_domain_name" {
  description = "Custom domain for the assets CDN"
  type        = string
  default     = "content.gifwidgets.com"
}

variable "enable_domain_redirect" {
  description = "Redirect old site and www hostnames to gifgadgets.com. Disable only while provisioning new domain connectivity."
  type        = bool
  default     = true
}

variable "additional_site_domains" {
  description = "Additional site hostnames mapped to their existing public Route 53 zone names. Requires a supplied ACM certificate covering every site hostname."
  type        = map(string)
  default = {
    "gifgadgets.com"     = "gifgadgets.com"
    "www.gifgadgets.com" = "gifgadgets.com"
  }
}

variable "route53_zone_id" {
  description = "Optional Route 53 hosted zone ID for the root domain. Set this to skip hosted zone name lookup."
  type        = string
  default     = "Z0214487EWN6AXBNZDBS"
  nullable    = true
}

variable "github_repo" {
  description = "GitHub repository used by the backend integration"
  type        = string
  default     = "r7butler/gifwidgets"
}

variable "acm_certificate_arn" {
  description = "Optional ACM certificate ARN (must be in us-east-1) for the root domain. Leave null to have Terraform create and validate one."
  type        = string
  default     = "arn:aws:acm:us-east-1:425750453898:certificate/a9928a42-ece7-42f9-bd4b-069cc5ef9a2d"
  nullable    = true
}

variable "content_acm_certificate_arn" {
  description = "Optional ACM certificate ARN (must be in us-east-1) for the assets domain. Leave null to have Terraform create and validate one."
  type        = string
  default     = "arn:aws:acm:us-east-1:425750453898:certificate/ef4942b6-ee6c-46d8-8cf4-03d990bf16d5"
  nullable    = true
}

variable "github_issue_poster_pat" {
  description = "Fine-grained GitHub PAT for posting issues to the configured GitHub repository"
  type        = string
  sensitive   = true
}

variable "monthly_budget_usd" {
  description = "Monthly AWS spend that triggers budget alerts. Alerts notify only; nothing is disabled automatically."
  type        = string
  default     = "25"
}

variable "budget_alert_email" {
  description = "Address that receives AWS budget alerts."
  type        = string
  default     = "r7butler.freelance@gmail.com"
}

variable "ip_hash_salt" {
  description = "Secret salt for hashing client IPs in rate-limit records. Without it an unsalted IPv4 hash is brute-forceable. Generate with: openssl rand -hex 32"
  type        = string
  sensitive   = true
}

variable "modal_api_key" {
  description = "Shared secret used by Lambda to authenticate requests to Modal endpoints"
  type        = string
  sensitive   = true
}

variable "modal_tracker_url" {
  description = "URL of the Modal tracker endpoint (SAM2 tracking)"
  type        = string
  default     = "https://r7butler--gifwidgets-tracker-fastapi-app.modal.run"
}

variable "modal_converter_url" {
  description = "URL of the Modal converter endpoint (video trimming/conversion)"
  type        = string
  default     = "https://r7butler--gifwidgets-converter-converter-web.modal.run"
}
