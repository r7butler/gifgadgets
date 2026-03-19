output "site_bucket_name" {
  description = "S3 bucket name for the static site"
  value       = aws_s3_bucket.site.id
}

output "assets_bucket_name" {
  description = "S3 bucket name for GIF assets"
  value       = aws_s3_bucket.assets.id
}

output "cloudfront_url" {
  description = "CloudFront distribution URL"
  value       = "https://${aws_cloudfront_distribution.site.domain_name}"
}

output "api_url" {
  description = "API URL (routed through CloudFront at /api)"
  value       = "https://${var.root_domain_name}/api"
}

output "assets_cdn_url" {
  description = "CloudFront URL for GIF assets"
  value       = "https://${var.assets_domain_name}"
}

output "site_cloudfront_domain" {
  description = "CloudFront domain for the site custom domain"
  value       = aws_cloudfront_distribution.site.domain_name
}

output "lambda_function_name" {
  description = "Lambda function name for backend deploys"
  value       = aws_lambda_function.api.function_name
}
