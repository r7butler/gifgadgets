# ── Tracker Lambda (SAM2 object tracking, container image) ───────────────────
#
# Deploy in two phases:
#   Phase 1:  terraform apply -target=aws_ecr_repository.tracker
#   Phase 2:  (build & push Docker image, then)
#             terraform apply -var="tracker_image_uri=<ECR_URI>:<tag>"

variable "tracker_image_uri" {
  description = "ECR image URI for the tracker Lambda — set by deploy-tracker.sh"
  type        = string
  default     = ""
}

# ── ECR repository ────────────────────────────────────────────────────────────

resource "aws_ecr_repository" "tracker" {
  name                 = "gifcaption-tracker"
  image_tag_mutability = "MUTABLE"

  image_scanning_configuration {
    scan_on_push = false
  }
}

resource "aws_ecr_lifecycle_policy" "tracker" {
  repository = aws_ecr_repository.tracker.name

  policy = jsonencode({
    rules = [
      {
        rulePriority = 1
        description  = "Keep only the 3 most recent images"
        selection = {
          tagStatus   = "any"
          countType   = "imageCountMoreThan"
          countNumber = 3
        }
        action = { type = "expire" }
      }
    ]
  })
}

# ── IAM role for tracker Lambda ───────────────────────────────────────────────

resource "aws_iam_role" "tracker" {
  name = "gifcaption-tracker-role"

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

resource "aws_iam_role_policy_attachment" "tracker_logs" {
  role       = aws_iam_role.tracker.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# ── Lambda function (only created once the image URI is available) ────────────

resource "aws_lambda_function" "tracker" {
  count = var.tracker_image_uri != "" ? 1 : 0

  function_name = "gifcaption-tracker"
  role          = aws_iam_role.tracker.arn
  package_type  = "Image"
  image_uri     = var.tracker_image_uri

  timeout     = 300
  memory_size = 3008

  environment {
    variables = {
      PYTHONDONTWRITEBYTECODE = "1"
    }
  }
}

# ── Lambda Function URL ───────────────────────────────────────────────────────

resource "aws_lambda_function_url" "tracker" {
  count = var.tracker_image_uri != "" ? 1 : 0

  function_name      = aws_lambda_function.tracker[0].function_name
  authorization_type = "NONE"

  cors {
    allow_origins = ["*"]
    allow_methods = ["POST"]
    allow_headers = ["Content-Type"]
    max_age       = 3600
  }
}

resource "aws_lambda_permission" "tracker_url_public" {
  count = var.tracker_image_uri != "" ? 1 : 0

  statement_id           = "TrackerFunctionURLAllowPublicAccess"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.tracker[0].function_name
  principal              = "*"
  function_url_auth_type = "NONE"
}

resource "aws_lambda_permission" "tracker_url_invoke" {
  count = var.tracker_image_uri != "" ? 1 : 0

  statement_id  = "TrackerFunctionURLAllowPublicInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.tracker[0].function_name
  principal     = "*"
}
