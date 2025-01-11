import { Construct } from 'constructs';
import * as ecr from 'aws-cdk-lib/aws-ecr';

export class ImageRepositories extends Construct {
  public readonly gridwalkProduct: ecr.Repository;
  public readonly gridwalkUi: ecr.Repository;
  public readonly gridwalkBackend: ecr.Repository;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.gridwalkProduct = new ecr.Repository(this, 'GridwalkProduct');
    this.gridwalkUi = new ecr.Repository(this, 'GridwalkUi');
    this.gridwalkBackend = new ecr.Repository(this, 'GridwalkBackend');
  }
}
