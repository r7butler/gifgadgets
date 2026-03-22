terraform {
  required_version = ">= 1.3"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}


provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

locals {
  root_domain_name       = var.root_domain_name
  assets_domain_name     = var.assets_domain_name
  site_certificate_arn   = var.acm_certificate_arn != null ? var.acm_certificate_arn : aws_acm_certificate_validation.site[0].certificate_arn
  assets_certificate_arn = var.content_acm_certificate_arn != null ? var.content_acm_certificate_arn : aws_acm_certificate_validation.assets[0].certificate_arn
  github_pat_secret_name = "${var.project_slug}/github-issue-post-pat"
  lambda_role_name       = "${var.project_slug}-lambda-role"
  lambda_policy_name     = "${var.project_slug}-lambda-policy"
  lambda_function_name   = "${var.project_slug}-api"
  rewrite_function_name  = "${var.project_slug}-rewrite-index"
  coop_function_name     = "${var.project_slug}-add-coop-headers"
  site_oac_name          = "${var.project_slug}-site-oac"
  assets_oac_name        = "${var.project_slug}-assets-oac"
  lambda_oac_name        = "${var.project_slug}-lambda-oac"
  lambda_url_domain      = trimsuffix(trimprefix(aws_lambda_function_url.api.function_url, "https://"), "/")
}

# ---------- S3: Static Site Bucket ----------

resource "aws_s3_bucket" "site" {
  bucket = var.site_bucket_name
}

resource "aws_s3_bucket_public_access_block" "site" {
  bucket                  = aws_s3_bucket.site.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_policy" "site" {
  bucket = aws_s3_bucket.site.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.site.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = aws_cloudfront_distribution.site.arn
          }
        }
      }
    ]
  })
}

# ---------- S3: GIF Assets Bucket ----------

resource "aws_s3_bucket" "assets" {
  bucket = var.assets_bucket_name
}

resource "aws_s3_bucket_public_access_block" "assets" {
  bucket                  = aws_s3_bucket.assets.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_cors_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "PUT"]
    allowed_origins = ["https://gifwidgets.com", "http://localhost:3000"]
    max_age_seconds = 3600
  }
}

# ---------- S3 Lifecycle: Expire temp convert files ----------

resource "aws_s3_bucket_lifecycle_configuration" "assets" {
  bucket = aws_s3_bucket.assets.id

  rule {
    id     = "expire-convert-temp"
    status = "Enabled"

    filter {
      prefix = "convert/"
    }

    expiration {
      days = 1
    }
  }

  rule {
    id     = "expire-track-temp"
    status = "Enabled"

    filter {
      prefix = "track/"
    }

    expiration {
      days = 1
    }
  }
}

# ---------- Secrets Manager: GitHub PAT ----------

resource "aws_secretsmanager_secret" "github_pat" {
  name        = local.github_pat_secret_name
  description = "Fine-grained GitHub PAT for posting issues to ${var.github_repo}"
}

resource "aws_secretsmanager_secret_version" "github_pat" {
  secret_id     = aws_secretsmanager_secret.github_pat.id
  secret_string = var.github_pat
}

# ---------- IAM User for Modal Converter (GPU MP4 conversion) ----------

resource "aws_iam_user" "modal_converter" {
  name = "${var.project_slug}-modal-converter"
}

resource "aws_iam_user_policy" "modal_converter" {
  name = "${var.project_slug}-modal-converter-s3"
  user = aws_iam_user.modal_converter.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:PutObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.assets.arn}/convert/*"
      }
    ]
  })
}

resource "aws_iam_access_key" "modal_converter" {
  user = aws_iam_user.modal_converter.name
}

output "modal_converter_access_key_id" {
  value = aws_iam_access_key.modal_converter.id
}

output "modal_converter_secret_access_key" {
  value     = aws_iam_access_key.modal_converter.secret
  sensitive = true
}

# ---------- IAM User for Modal Tracker (GPU object tracking) ----------

resource "aws_iam_user" "modal_tracker" {
  name = "${var.project_slug}-modal-tracker"
}

resource "aws_iam_user_policy" "modal_tracker" {
  name = "${var.project_slug}-modal-tracker-s3"
  user = aws_iam_user.modal_tracker.name

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.assets.arn}/track/*"
      }
    ]
  })
}

resource "aws_iam_access_key" "modal_tracker" {
  user = aws_iam_user.modal_tracker.name
}

output "modal_tracker_access_key_id" {
  value = aws_iam_access_key.modal_tracker.id
}

output "modal_tracker_secret_access_key" {
  value     = aws_iam_access_key.modal_tracker.secret
  sensitive = true
}

# ---------- IAM Role for Lambda ----------

resource "aws_iam_role" "lambda" {
  name = local.lambda_role_name

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect    = "Allow"
        Principal = { Service = "lambda.amazonaws.com" }
        Action    = "sts:AssumeRole"
      }
    ]
  })
}

resource "aws_iam_role_policy" "lambda" {
  name = local.lambda_policy_name
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "s3:PutObject",
          "s3:GetObject",
          "s3:DeleteObject"
        ]
        Resource = "${aws_s3_bucket.assets.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = "s3:PutObject"
        Resource = "${aws_s3_bucket.site.arn}/g/*"
      },
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents"
        ]
        Resource = "arn:aws:logs:*:*:*"
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = aws_secretsmanager_secret.github_pat.arn
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:PutItem",
          "dynamodb:GetItem",
          "dynamodb:UpdateItem",
          "dynamodb:Query"
        ]
        Resource = [
          aws_dynamodb_table.jobs.arn,
          "${aws_dynamodb_table.jobs.arn}/index/*"
        ]
      }
    ]
  })
}

# ---------- Lambda Function ----------

resource "aws_lambda_function" "api" {
  function_name                  = local.lambda_function_name
  role                           = aws_iam_role.lambda.arn
  handler                        = "handler.handler"
  runtime                        = "python3.11"
  timeout                        = 180
  memory_size                    = 1024
  layers                         = [aws_lambda_layer_version.ffmpeg.arn]

  filename         = "${path.module}/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/lambda.zip")

  environment {
    variables = {
      ASSETS_BUCKET       = aws_s3_bucket.assets.id
      SITE_BUCKET         = aws_s3_bucket.site.id
      ASSETS_CDN_URL      = "https://${local.assets_domain_name}"
      SITE_CDN_URL        = "https://${local.root_domain_name}"
      GITHUB_SECRET_ARN   = aws_secretsmanager_secret.github_pat.arn
      GITHUB_REPO         = var.github_repo
      JOBS_TABLE          = aws_dynamodb_table.jobs.name
      FEATURES_DISABLED   = ""
      MODAL_TRACKER_URL   = var.modal_tracker_url
      MODAL_CONVERTER_URL = var.modal_converter_url
    }
  }
}

# ---------- FFmpeg Lambda Layer ----------

resource "aws_lambda_layer_version" "ffmpeg" {
  layer_name          = "${var.project_slug}-ffmpeg"
  filename            = "${path.module}/ffmpeg-layer.zip"
  source_code_hash    = filebase64sha256("${path.module}/ffmpeg-layer.zip")
  compatible_runtimes = ["python3.11"]
  description         = "Static ffmpeg binary for video conversion"
}

# ---------- DynamoDB: Jobs Table ----------

resource "aws_dynamodb_table" "jobs" {
  name         = "${var.project_slug}-jobs"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "job_id"

  attribute {
    name = "job_id"
    type = "S"
  }

  attribute {
    name = "ip_hash"
    type = "S"
  }

  attribute {
    name = "created_at"
    type = "N"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }

  global_secondary_index {
    name            = "ip_hash-created_at-index"
    hash_key        = "ip_hash"
    range_key       = "created_at"
    projection_type = "KEYS_ONLY"
  }
}

# ---------- Lambda Function URL (IAM-protected, accessed via CloudFront OAC) ----------

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = "AWS_IAM"
}

resource "aws_lambda_permission" "cloudfront" {
  statement_id  = "AllowCloudFrontInvoke"
  action        = "lambda:InvokeFunctionUrl"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

# Dual Auth requirement (since Oct 2025): Lambda Function URLs need both permissions
resource "aws_lambda_permission" "cloudfront_invoke" {
  statement_id  = "AllowCloudFrontInvokeFunction"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "cloudfront.amazonaws.com"
  source_arn    = aws_cloudfront_distribution.site.arn
}

# ---------- CloudFront Function: Directory Index Rewrite ----------

resource "aws_cloudfront_function" "rewrite_index" {
  name    = local.rewrite_function_name
  runtime = "cloudfront-js-2.0"
  comment = "Rewrite /path/ and /path to /path/index.html for S3 static site"
  publish = true

  code = <<-EOF
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      // Append index.html if URI ends with '/' or has no file extension
      if (uri.endsWith('/')) {
        request.uri = uri + 'index.html';
      } else if (!uri.includes('.', uri.lastIndexOf('/'))) {
        request.uri = uri + '/index.html';
      }
      return request;
    }
  EOF
}

# ---------- CloudFront Function: Add COOP/COEP headers for FFmpeg pages ----------

resource "aws_cloudfront_function" "add_coop_headers" {
  name    = local.coop_function_name
  runtime = "cloudfront-js-2.0"
  comment = "Add Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers for video converter pages that require SharedArrayBuffer"
  publish = true

  code = <<-EOF
    function handler(event) {
      var response = event.response;
      var uri = event.request.uri;
      return response;
    }
  EOF
}

# ---------- WAF ----------

resource "aws_wafv2_web_acl" "api" {
  provider = aws.us_east_1
  name     = "${var.project_slug}-waf"
  scope    = "CLOUDFRONT"

  default_action {
    allow {}
  }

  rule {
    name     = "api-rate-limit"
    priority = 1

    action {
      block {
        custom_response {
          response_code = 429
        }
      }
    }

    statement {
      rate_based_statement {
        limit              = 1000
        aggregate_key_type = "IP"

        scope_down_statement {
          byte_match_statement {
            search_string         = "/api/"
            positional_constraint = "STARTS_WITH"

            field_to_match {
              uri_path {}
            }

            text_transformation {
              priority = 0
              type     = "NONE"
            }
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_slug}-api-rate-limit"
    }
  }

  rule {
    name     = "aws-common-rules"
    priority = 2

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {}
          }
        }
      }
    }

    visibility_config {
      sampled_requests_enabled   = true
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project_slug}-aws-common-rules"
    }
  }

  visibility_config {
    sampled_requests_enabled   = true
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project_slug}-waf"
  }
}

# ---------- CloudFront ----------

resource "aws_cloudfront_origin_access_control" "site" {
  name                              = local.site_oac_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# OAC for the GIF assets bucket
resource "aws_cloudfront_origin_access_control" "assets" {
  name                              = local.assets_oac_name
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# OAC for Lambda Function URL
resource "aws_cloudfront_origin_access_control" "lambda" {
  name                              = local.lambda_oac_name
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# CloudFront distribution for GIF assets (stable, SEO-friendly URLs)
resource "aws_cloudfront_distribution" "assets" {
  enabled = true
  comment = "${var.site_brand_name} GIF assets CDN"
  aliases = [local.assets_domain_name]

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 0
    default_ttl = 86400
    max_ttl     = 31536000
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.assets_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# Allow the assets CloudFront distribution to read from the assets bucket
resource "aws_s3_bucket_policy" "assets" {
  bucket = aws_s3_bucket.assets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid       = "AllowCloudFrontOAC"
        Effect    = "Allow"
        Principal = { Service = "cloudfront.amazonaws.com" }
        Action    = "s3:GetObject"
        Resource  = "${aws_s3_bucket.assets.arn}/*"
        Condition = {
          StringEquals = {
            "AWS:SourceArn" = [
              aws_cloudfront_distribution.assets.arn,
              aws_cloudfront_distribution.site.arn,
            ]
          }
        }
      }
    ]
  })
}

# ---------- Route 53 ----------

data "aws_route53_zone" "root" {
  count        = var.route53_zone_id == null ? 1 : 0
  name         = "${local.root_domain_name}."
  private_zone = false
}

locals {
  route53_zone_id = var.route53_zone_id != null ? var.route53_zone_id : data.aws_route53_zone.root[0].zone_id
}

resource "aws_acm_certificate" "site" {
  count             = var.acm_certificate_arn == null ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.root_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "site_cert_validation" {
  count = var.acm_certificate_arn == null ? 1 : 0

  zone_id = local.route53_zone_id
  name    = tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_type
  ttl     = 60
  records = [tolist(aws_acm_certificate.site[0].domain_validation_options)[0].resource_record_value]
}

resource "aws_acm_certificate_validation" "site" {
  count                   = var.acm_certificate_arn == null ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.site[0].arn
  validation_record_fqdns = [aws_route53_record.site_cert_validation[0].fqdn]
}

resource "aws_acm_certificate" "assets" {
  count             = var.content_acm_certificate_arn == null ? 1 : 0
  provider          = aws.us_east_1
  domain_name       = local.assets_domain_name
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_route53_record" "assets_cert_validation" {
  count = var.content_acm_certificate_arn == null ? 1 : 0

  zone_id = local.route53_zone_id
  name    = tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_name
  type    = tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_type
  ttl     = 60
  records = [tolist(aws_acm_certificate.assets[0].domain_validation_options)[0].resource_record_value]
}

resource "aws_acm_certificate_validation" "assets" {
  count                   = var.content_acm_certificate_arn == null ? 1 : 0
  provider                = aws.us_east_1
  certificate_arn         = aws_acm_certificate.assets[0].arn
  validation_record_fqdns = [aws_route53_record.assets_cert_validation[0].fqdn]
}

resource "aws_route53_record" "root" {
  zone_id = local.route53_zone_id
  name    = local.root_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.site.domain_name
    zone_id                = aws_cloudfront_distribution.site.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_route53_record" "content" {
  zone_id = local.route53_zone_id
  name    = local.assets_domain_name
  type    = "A"

  alias {
    name                   = aws_cloudfront_distribution.assets.domain_name
    zone_id                = aws_cloudfront_distribution.assets.hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_cloudfront_distribution" "site" {
  enabled             = true
  default_root_object = "index.html"
  comment             = "${var.site_brand_name} static site"
  aliases             = [local.root_domain_name]
  web_acl_id          = aws_wafv2_web_acl.api.arn

  origin {
    domain_name              = aws_s3_bucket.site.bucket_regional_domain_name
    origin_id                = "s3-site"
    origin_access_control_id = aws_cloudfront_origin_access_control.site.id
  }

  origin {
    domain_name              = aws_s3_bucket.assets.bucket_regional_domain_name
    origin_id                = "s3-assets"
    origin_access_control_id = aws_cloudfront_origin_access_control.assets.id
  }

  origin {
    domain_name              = local.lambda_url_domain
    origin_id                = "lambda-api"
    origin_access_control_id = aws_cloudfront_origin_access_control.lambda.id

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  # Route /api/* to Lambda Function URL (no caching, forward needed headers)
  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "lambda-api"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD"]
    compress               = true

    cache_policy_id          = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad"
    origin_request_policy_id = "b689b0a8-53d0-40ab-baf2-68738e2966ac"
  }

  # Route /share/* to the assets S3 bucket (immutable shared GIFs)
  ordered_cache_behavior {
    path_pattern           = "/share/*"
    target_origin_id       = "s3-assets"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    min_ttl     = 86400
    default_ttl = 31536000
    max_ttl     = 31536000
  }

  default_cache_behavior {
    target_origin_id       = "s3-site"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.rewrite_index.arn
    }

    function_association {
      event_type   = "viewer-response"
      function_arn = aws_cloudfront_function.add_coop_headers.arn
    }

    min_ttl     = 0
    default_ttl = 3600
    max_ttl     = 86400
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    acm_certificate_arn      = local.site_certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
}

# ---------- CloudWatch ----------

resource "aws_cloudwatch_log_group" "lambda" {
  name              = "/aws/lambda/${local.lambda_function_name}"
  retention_in_days = 14
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_slug}-overview"
  dashboard_body = jsonencode({
    widgets = [
      # --- Row 1: Lambda health ---
      {
        type   = "text"
        x      = 0, y = 0, width = 24, height = 1
        properties = { markdown = "## Lambda API" }
      },
      {
        type   = "metric"
        x      = 0, y = 1, width = 8, height = 6
        properties = {
          title  = "Invocations"
          region = "us-east-1"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/Lambda", "Invocations", "FunctionName", local.lambda_function_name],
            [".", "Errors", ".", "."],
            [".", "Throttles", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 8, y = 1, width = 8, height = 6
        properties = {
          title  = "Duration (ms)"
          region = "us-east-1"
          period = 300
          metrics = [
            ["AWS/Lambda", "Duration", "FunctionName", local.lambda_function_name, { stat = "Average" }],
            ["...", { stat = "p95" }],
            ["...", { stat = "Maximum" }],
          ]
        }
      },
      {
        type   = "metric"
        x      = 16, y = 1, width = 8, height = 6
        properties = {
          title  = "Concurrent Executions"
          region = "us-east-1"
          stat   = "Maximum"
          period = 300
          metrics = [
            ["AWS/Lambda", "ConcurrentExecutions", "FunctionName", local.lambda_function_name],
          ]
        }
      },
      # --- Row 2: WAF ---
      {
        type   = "text"
        x      = 0, y = 7, width = 24, height = 1
        properties = { markdown = "## WAF" }
      },
      {
        type   = "metric"
        x      = 0, y = 8, width = 12, height = 6
        properties = {
          title  = "Allowed vs Blocked"
          region = "us-east-1"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/WAFV2", "AllowedRequests", "WebACL", "${var.project_slug}-waf", "Rule", "ALL", "Region", "us-east-1"],
            [".", "BlockedRequests", ".", ".", ".", ".", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12, y = 8, width = 12, height = 6
        properties = {
          title  = "Rate-Limited Requests"
          region = "us-east-1"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/WAFV2", "BlockedRequests", "WebACL", "${var.project_slug}-waf", "Rule", "api-rate-limit", "Region", "us-east-1"],
          ]
        }
      },
      # --- Row 3: CloudFront ---
      {
        type   = "text"
        x      = 0, y = 14, width = 24, height = 1
        properties = { markdown = "## CloudFront (Site)" }
      },
      {
        type   = "metric"
        x      = 0, y = 15, width = 8, height = 6
        properties = {
          title  = "Requests"
          region = "us-east-1"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/CloudFront", "Requests", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"],
          ]
        }
      },
      {
        type   = "metric"
        x      = 8, y = 15, width = 8, height = 6
        properties = {
          title  = "Error Rate (%)"
          region = "us-east-1"
          stat   = "Average"
          period = 300
          metrics = [
            ["AWS/CloudFront", "4xxErrorRate", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"],
            [".", "5xxErrorRate", ".", ".", ".", "."],
          ]
        }
      },
      {
        type   = "metric"
        x      = 16, y = 15, width = 8, height = 6
        properties = {
          title  = "Data Transferred"
          region = "us-east-1"
          stat   = "Sum"
          period = 300
          metrics = [
            ["AWS/CloudFront", "BytesDownloaded", "DistributionId", aws_cloudfront_distribution.site.id, "Region", "Global"],
          ]
        }
      },
    ]
  })
}
