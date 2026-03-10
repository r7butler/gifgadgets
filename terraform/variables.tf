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

variable "openai_api_key" {
  description = "OpenAI API key for chat completions (stored in Secrets Manager)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "gemini_api_key" {
  description = "Google Gemini API key for vision title generation (stored in Secrets Manager)"
  type        = string
  sensitive   = true
  default     = ""
}
