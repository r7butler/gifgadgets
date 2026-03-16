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

output "lambda_function_url" {
  description = "Lambda Function URL (API base URL)"
  value       = aws_lambda_function_url.api.function_url
}

output "assets_cdn_url" {
  description = "CloudFront URL for GIF assets"
  value       = "https://${var.assets_domain_name}"
}

output "site_cloudfront_domain" {
  description = "CloudFront domain for the site custom domain"
  value       = aws_cloudfront_distribution.site.domain_name
}
