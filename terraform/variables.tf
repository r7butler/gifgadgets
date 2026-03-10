variable "aws_region" {
  description = "AWS region for all resources"
  type        = string
  default     = "us-east-1"
}

variable "site_bucket_name" {
  description = "Name of the S3 bucket for the static site"
  type        = string
  default     = "gifcaption-site"
}

variable "assets_bucket_name" {
  description = "Name of the S3 bucket for GIF assets"
  type        = string
  default     = "gifcaption-assets"
}

variable "acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1) for the gifcaption.com custom domain"
  type        = string
  default     = "arn:aws:acm:us-east-1:759371407688:certificate/233f0971-73b2-4fba-bac1-4b0d51a43cd4"
}

variable "content_acm_certificate_arn" {
  description = "ACM certificate ARN (must be in us-east-1) for the content.gifcaption.com custom domain"
  type        = string
  default     = "arn:aws:acm:us-east-1:759371407688:certificate/ae2c065f-bde1-49e4-a62a-32a59d8f84f3"
}
