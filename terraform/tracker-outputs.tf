output "tracker_ecr_url" {
  description = "ECR repository URL — use as the base for tracker_image_uri"
  value       = aws_ecr_repository.tracker.repository_url
}

output "tracker_function_url" {
  description = "Lambda Function URL for the SAM2 tracker (empty until first deploy)"
  value       = var.tracker_image_uri != "" ? aws_lambda_function_url.tracker[0].function_url : ""
}
